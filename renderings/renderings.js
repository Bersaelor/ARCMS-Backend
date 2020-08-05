/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const ec2 = new AWS.EC2();
const { getAccessLvl, accessLvlMayCreate } = require('shared/access_methods')

const statusStrings = {
    requested: "REQUESTED",
    rendering: "RENDERING",
    finished: "FINISHED",
    failed: "FAILED"
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

const getRenderings = async (brand, category, model) => {
    var params
    if (category) {
        params = {
            KeyConditionExpression: "#id = :value and begins_with(#sk, :sk)",
            ExpressionAttributeNames:{
                "#id": "id",
                "#sk": "sk",
                "#p": "parameters",
                "#s": "status"
            },
            ExpressionAttributeValues: {
                ":value": `rendering#${brand}`,
                ":sk": model ? `${category}#${model}` : category
            },
        };    
    } else {
        params = {
            KeyConditionExpression: "#id = :value",
            ExpressionAttributeNames:{
                "#id": "id",
                "#p": "parameters",
                "#s": "status"
            },
            ExpressionAttributeValues: {
                ":value": `rendering#${brand}`
            },
        };
    }
    params.TableName = process.env.CANDIDATE_TABLE
    params.ProjectionExpression = "sk, #s, #p, finished, s3key, cost"
    params.ScanIndexForward = false

    return dynamoDb.query(params).promise()
}

const getRenderingFromDB = async (brand, category, model, timeStamp) => {
    let params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk",
        KeyConditionExpression: "#id = :value and #sk = :sk",
        ExpressionAttributeNames:{
            "#id": "id",
            "#sk": "sk",
        },
        ExpressionAttributeValues: {
            ":value": `rendering#${brand}`,
            ":sk": `${category}#${model}#${timeStamp}`
        },
    }

    return dynamoDb.query(params).promise()
}

const createRenderingInDB = async (brand, category, id, parameters, modelS3Key, timeStamp) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `rendering#${brand}`,
            "sk": `${category}#${id}#${timeStamp}`,
            "modelS3Key": modelS3Key,
            "parameters": parameters ? JSON.stringify(parameters) : "{}",
            "status": statusStrings.requested
        }
    };

    return dynamoDb.put(params).promise();
}

const getModel = async (brand, category, id) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, modelFile",
        KeyConditionExpression: "#id = :value and #sk = :searchKey",
        ExpressionAttributeNames:{
            "#id": "id",
            "#sk": "sk"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#model`,
            ":searchKey": `${category}#${id}`
        },
    };

    return dynamoDb.query(params).promise()
}

async function updateModel(s3key, brand, category, modelId, timeStamp, finishedTimeStamp, cost) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: `rendering#${brand}`, sk: `${category}#${modelId}#${timeStamp}` },
        UpdateExpression: `set finished = :f, #s = :status, s3key = :s3key, cost = :cost`,
        ExpressionAttributeNames:{
            "#s": "status",
        },
        ExpressionAttributeValues: {
            ":f": finishedTimeStamp,
            ":status" : statusStrings.finished,
            ":s3key": s3key,
            ":cost": cost
        },
    };

    return dynamoDb.update(params).promise()
}

const convertStoredRendering = (stored) => {
    var converted = stored
    let skComponents = stored.sk.split('#')
    converted.category = skComponents[0]
    converted.model = skComponents[1]
    const timeStamp = parseInt(skComponents[2], 10)
    converted.created = timeStamp

    delete converted.sk
    try {
        converted.parameters = stored.parameters ? JSON.parse(stored.parameters) : {}
    } catch (error) {
        console.log("Failed to convert json because: ", error)
    }
    converted.result_url = stored.s3key ? "https://render.looc.io/" + stored.s3key : ""
    delete converted.s3key
    return converted
}

function writeParametersToS3(parameters, uploadKey) {
    const params = {
        Bucket: process.env.RENDERING_BUCKET,
        Key: `${uploadKey}/parameters.json`,
        Body: JSON.stringify(parameters)
    }
    return s3.putObject(params).promise()
}

function startInstance(fileKey, uploadKey) {
    const init_script = `#!/bin/bash -x
echo Initializing g4dn-Renderer
aws s3 cp s3://looc-server-side-rendering/p2-init.sh /tmp/ 
chmod +x /tmp/p2-init.sh
/tmp/p2-init.sh ${ fileKey } ${ uploadKey }
`
    const base64Script = Buffer.from(init_script).toString('base64')

    var params = {
        ImageId: "ami-034cd0836aa8c9bee",
        InstanceType: "g4dn.xlarge",
        KeyName: "Convert3DEC2Pair",
        MaxCount: 1,
        MinCount: 1,
        SecurityGroupIds: [ "sg-d572aabd" ],
        IamInstanceProfile: {
            Arn: "arn:aws:iam::338756162532:instance-profile/ServerRenderAccess"
        },
        InstanceInitiatedShutdownBehavior: "terminate",
        UserData: base64Script
    };

    return new Promise((resolve, reject) => {
        let request = ec2.runInstances(params, (error, data) => {
            if (error) reject(error); 
            else resolve(data);
        });
    })
}

// Get an array of renderings, optionally filtered by category and model, paginated
exports.get = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const category = event.queryStringParameters && event.queryStringParameters.category;
    const model = event.queryStringParameters && event.queryStringParameters.model;

    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand in the call.`,
        });
        return;
    }    
    
    console.log("Checking for renderings for ", brand, ", for category: ", category, ", model: ", model)
    try {
        const dataPromise = getRenderings(brand, category, model)
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to see the list of renderings"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const data = await dataPromise
        const renderings = data.Items.map(render => convertStoredRendering(render))
        
        var response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(renderings)
        };

        callback(null, response);
    } catch(error) {
        console.error('Query for renderings failed. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};

// Post the configuration for a requested rendering, 
exports.new = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    const body = JSON.parse(event.body)

    const category = body.category
    const modelId = body.model
    const parameters = body.parameters

    if (!brand || !category || !modelId) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand, category and model in the call.`,
        });
        return;
    }    

    console.log("Requesting rendering for: ", brand, ", ", category, ", model: ", modelId)
    try {
        const modelPromise = getModel(brand, category, modelId)    
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to see the list of renderings"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const modelData = await modelPromise
        if (!modelData || !modelData.Items || modelData.Items.length == 0 || !modelData.Items[0].modelFile) {
            const msg = `Failed to find model with brand: ${brand}, category: ${category}, modelId: ${modelId} in DB`
            console.error(msg)
            return
        }
        const modelS3Key = modelData.Items[0].modelFile
        let timeStamp = (new Date()).getTime()
        let updateDBEntryPromise = createRenderingInDB(brand, category, modelId, parameters, modelS3Key, timeStamp)
        let uploadKey = `${brand}/${category}/${modelId}/${timeStamp}`
        let saveParametersPromise = writeParametersToS3(parameters, uploadKey)
        console.log("Starting rendering for model ", modelS3Key, " which will be uploaded to ", uploadKey)
        let launchEC2Promise = startInstance(modelS3Key, uploadKey)
        const updateDBResult = await updateDBEntryPromise
        const writeParametersResponse = await saveParametersPromise
        const instanceStartResponse = await launchEC2Promise
        console.log(`Success: ${instanceStartResponse.Instances} Instances created and db updated: ${JSON.stringify(updateDBResult)}, writeParametersResponse: ${JSON.stringify(writeParametersResponse)}`)

        var response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: `Success: ${instanceStartResponse.Instances.length} Instances created and db updated: ${JSON.stringify(updateDBResult)}` 
        };

        callback(null, response);
    } catch(error) {
        console.error('Query to request new rendering failed. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}

// Update the metadata in the DB when a rendering has finished
exports.finished = async (event, context, callback) => {
    try {
        for (const index in event.Records) {
            const record = event.Records[index]
            const key = record.s3.object.key
            const keyComponents = key.split('/')
            const brand = keyComponents[0]
            const category = keyComponents[1]
            const modelId = keyComponents[2]
            const timeStamp = keyComponents[3]
            const finishedTimeStamp = (new Date()).getTime()

            const renderingData = await getRenderingFromDB(brand, category, modelId, timeStamp)

            if (!renderingData || !renderingData.Items || renderingData.Items.length == 0) {
                const msg = `Failed to find rendering with brand: ${brand}, category: ${category}, modelId: ${modelId} in DB`
                console.error(msg)
                callback(null, {msg: msg})
                return
            }

            const rendering = convertStoredRendering(renderingData.Items[0])
            const renderingTimeInS = Math.max(60, (finishedTimeStamp - rendering.created) / 1000)
            console.log("Rendering took ", renderingTimeInS, "s")
            const costPerHour = 0.658
            const cost = renderingTimeInS / 3600 * costPerHour

            const updateSuccess = await updateModel(key, brand, category, modelId, timeStamp, finishedTimeStamp, cost)
            console.log("Updating model with finished ", key, " in db success: ", updateSuccess)    

            callback(null, {msg: "Success"})
        }
    } catch (error) {
        callback(error, {msg: `Failed to save data because of ${error.toString()}`})
    }
}
