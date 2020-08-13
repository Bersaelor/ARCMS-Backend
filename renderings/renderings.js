/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const ec2 = new AWS.EC2();
const pricing = new AWS.Pricing({
    apiVersion: '2017-10-15',
    region: 'us-east-1'
});
const { getAccessLvl, accessLvlMayRender } = require('shared/access_methods')
const { paginate } = require('shared/pagination')
const brandSettings = require('brand_settings.json')
const instanceType = "g4dn.xlarge"
const defaultPerPage = 20;

const first = obj => obj[Object.keys(obj)[0]];

const statusStrings = {
    requested: "REQUESTED",
    waitingForResource: "WAITING",
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

const getRenderings = async (brand, category, model, perPage, LastEvaluatedKey) => {
    var params
    if (category) {
        params = {
            KeyConditionExpression: "#id = :value and begins_with(#sk, :sk)",
            ExpressionAttributeNames:{
                "#id": "id",
                "#sk": "sk",
                "#p": "parameters",
                "#s": "status",
                "#l": "log"
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
                "#s": "status",
                "#l": "log"
            },
            ExpressionAttributeValues: {
                ":value": `rendering#${brand}`
            },
        };
    }
    params.Limit = perPage
    params.TableName = process.env.CANDIDATE_TABLE
    params.ProjectionExpression = "sk, #s, #p, #l, finished, s3key, cost, renderStarted"
    params.ScanIndexForward = false
    if (LastEvaluatedKey) { params.ExclusiveStartKey = LastEvaluatedKey }

    return dynamoDb.query(params).promise()
}

const getWaitingRenderings = async (brand) => {
    const params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, #s, modelS3Key",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id",
            "#s": "status"
        },
        ExpressionAttributeValues: {
            ":value": `rendering#${brand}`
        },
    }; 

    const data = await dynamoDb.query(params).promise()
    const waitingRenderings = data.Items && data.Items.filter(rendering => rendering.status === statusStrings.waitingForResource)
    return waitingRenderings || []
}

const getRenderingFromDB = async (brand, category, model, timeStamp) => {
    let params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, #p, renderStarted",
        KeyConditionExpression: "#id = :value and #sk = :sk",
        ExpressionAttributeNames:{
            "#id": "id",
            "#sk": "sk",
            "#p": "parameters"
        },
        ExpressionAttributeValues: {
            ":value": `rendering#${brand}`,
            ":sk": `${category}#${model}#${timeStamp}`
        },
    }

    return dynamoDb.query(params).promise()
}

const createRenderingInDB = async (brand, category, id, parameters, modelS3Key, timeStamp, waitingForFreeInstance, renderStarted) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `rendering#${brand}`,
            "sk": `${category}#${id}#${timeStamp}`,
            "modelS3Key": modelS3Key,
            "parameters": parameters ? JSON.stringify(parameters) : "{}",
            "status": waitingForFreeInstance ? statusStrings.waitingForResource : statusStrings.requested
        }
    };

    if (renderStarted) params.Item.renderStarted = renderStarted

    return dynamoDb.put(params).promise();
}

const saveReceiptInDB = async (brand, category, id, timeStamp, duration, cost, parameters) => {
    const timeString = (new Date()).toISOString()
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `receipt#${brand}`,
            "sk": timeString,
            "category": category,
            "model": id,
            "timeStamp": timeStamp,
            "duration": duration,
            "cost": cost,
            "parameters": parameters ? JSON.stringify(parameters) : "{}"
        }
    };

    return dynamoDb.put(params).promise();
}

const getReceipts = async (brand, year, month, LastEvaluatedKey) => {
    var sk = "2"
    if (year) sk = year
    if (month) sk = year + "-" + month

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, category, model, #t, #d, cost, #p",
        KeyConditionExpression: "#id = :value and begins_with(#sk, :sk)",
        ExpressionAttributeNames: {
            "#id": "id",
            "#sk": "sk",
            "#t": "timeStamp",
            "#d": "duration",
            "#p": "parameters"
        },
        ExpressionAttributeValues: {
            ":value": `receipt#${brand}`,
            ":sk": sk
        },
        ScanIndexForward: false
    };
    if (LastEvaluatedKey) { params.ExclusiveStartKey = LastEvaluatedKey }

    return dynamoDb.query(params).promise()
}

const convertStoredReceipt = (stored) => {
    var converted = stored
    converted.date = converted.sk
    delete converted.sk
    try {
        converted.parameters = stored.parameters ? JSON.parse(stored.parameters) : {}
    } catch (error) {
        console.log("Failed to convert json because: ", error)
    }

    return converted
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

const getEC2Pricing = async () => {
    var params = {
        Filters: [
            {
                Field: "location",
                Type: "TERM_MATCH",
                Value: "EU (Frankfurt)"
            },
            {
                Field: "operatingSystem",
                Type: "TERM_MATCH",
                Value: "Linux"
            },
            {
                Field: "operation",
                Type: "TERM_MATCH",
                Value: "RunInstances"
            },
            {
                Field: "usagetype",
                Type: "TERM_MATCH",
                Value: `EUC1-UnusedBox:${instanceType}`
            }
        ],
        FormatVersion: "aws_v1",
        MaxResults: 1,
        ServiceCode: "AmazonEC2"
    };

    return pricing.getProducts(params).promise().then((data) => {
        const item = data && data.PriceList && data.PriceList.length > 0 ? data.PriceList[0] : undefined
        const onDemandPrice = item && item.terms && item.terms.OnDemand && first(item.terms.OnDemand)
        const price = onDemandPrice && onDemandPrice.priceDimensions && first(onDemandPrice.priceDimensions)
        const pricePerUnit = price && price.pricePerUnit && price.pricePerUnit.USD && parseFloat(price.pricePerUnit.USD)
        return pricePerUnit
    })
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

async function updateRenderingStatus(status, brand, category, modelId, timeStamp) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: `rendering#${brand}`, sk: `${category}#${modelId}#${timeStamp}` },
        UpdateExpression: `set #s = :status`,
        ExpressionAttributeNames:{
            "#s": "status",
        },
        ExpressionAttributeValues: {
            ":status": status
        },
    };

    return dynamoDb.update(params).promise()
}

async function updateRenderingStatusAndRenderStarted(status, brand, category, modelId, timeStamp) {
    const renderStarted = (new Date()).getTime()

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: `rendering#${brand}`, sk: `${category}#${modelId}#${timeStamp}` },
        UpdateExpression: `set #s = :status, #r = :started`,
        ExpressionAttributeNames:{
            "#s": "status",
            "#r": "renderStarted"
        },
        ExpressionAttributeValues: {
            ":status": status,
            ":started": renderStarted
        },
    };

    return dynamoDb.update(params).promise()
}

async function updateModelLog(logS3Key, brand, category, modelId, timeStamp) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: `rendering#${brand}`, sk: `${category}#${modelId}#${timeStamp}` },
        UpdateExpression: `set #l = :f`,
        ExpressionAttributeNames:{
            "#l": "log",
        },
        ExpressionAttributeValues: {
            ":f": logS3Key,
        },
    };

    return dynamoDb.update(params).promise()
}

async function deleteRenderingFromDB(brand, category, model, timeStamp) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {
            id: `rendering#${brand}`,
            sk: `${category}#${model}#${timeStamp}`
        } 
    };

    return dynamoDb.delete(params).promise()
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
    converted.log = stored.log ? "https://render.looc.io/" + stored.log : ""

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

function makeUploadKey(brand, category, model, timeStamp) {
    return `${brand}/${category}/${model}/${timeStamp}`
}

function shortenedKey(key) {
    const maxLength = 124
    if (key.length > maxLength) {
        return key.slice(key.length - maxLength)
    } else {
        return key
    }
}

const uploadKeyTag = "UploadKey"
const loocEC2Tag = "loocec2tag"
const loocEC2TagRenderValue = "loocrenderInstance"
const maxRenderInstances = 20

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
        InstanceType: instanceType,
        KeyName: "Convert3DEC2Pair",
        MaxCount: 1,
        MinCount: 1,
        SecurityGroupIds: ["sg-d572aabd"],
        IamInstanceProfile: {
            Arn: "arn:aws:iam::338756162532:instance-profile/ServerRenderAccess"
        },
        TagSpecifications: [
            {
                ResourceType: "instance",
                Tags: [
                    {
                        Key: loocEC2Tag,
                        Value: loocEC2TagRenderValue
                    },
                    {
                        Key: uploadKeyTag,
                        Value: shortenedKey(uploadKey)
                    }
                ]
            }
        ],
        InstanceInitiatedShutdownBehavior: "terminate",
        UserData: base64Script
    };

    return ec2.runInstances(params).promise()
}

function findInstances(tagKey, tagValue) {
    var params = {
        Filters: [
            {
                Name: `tag:${tagKey}`,
                Values: [tagValue]
            }
        ]
    };

    return ec2.describeInstances(params).promise().then( data => {
        var instanceIds = []
        data.Reservations.forEach((reservation) => {
            reservation.Instances.forEach(function (instance) {
                if (instance.State.Name == 'running' || instance.State.Name == 'pending') {
                    instanceIds.push(instance.InstanceId);    
                }
            });
        });
        return instanceIds
    });
}

function terminateInstances(instanceIds) {
    const params = {
        InstanceIds: instanceIds
    }

    return new Promise((resolve, reject) => {
        ec2.terminateInstances(params, function(err, data) {
            if (err) { reject(err); return }
            else resolve(data)
        })    
    })
}

async function findAndTerminate(uploadKey) {
    const instanceIds = await findInstances(uploadKeyTag, uploadKey)
    console.log("instanceIds: ", instanceIds);
    if (instanceIds.length > 0) {
        const terminationResult = await terminateInstances(instanceIds)
        return terminationResult    
    } else {
        return `No instances running for uploadKey ${uploadKey}`
    }
}

async function checkForWaitingRenderings(brand) {
    console.log(`Checking for waiting renderings for ${brand}`)
    const renderings = await getWaitingRenderings(brand)
    if (renderings.length < 1) {
        console.log("No waiting renderings found")
        return
    }
    const rendering = renderings[0]
    let skComponents = rendering.sk.split('#')
    const category = skComponents[0]
    const model = skComponents[1]
    const timeStamp = parseInt(skComponents[2], 10)
    const uploadKey = makeUploadKey(brand, category, model, timeStamp)
    const updateSuccessPromise = updateRenderingStatusAndRenderStarted(statusStrings.requested, brand, category, model, timeStamp)
    const instanceStartResponse = await startInstance(rendering.modelS3Key, uploadKey)
    const updateDBResponse = await updateSuccessPromise

    console.log("Successfully created ", instanceStartResponse.Instances.length, " instances to render ", uploadKey, " and updateDB: ", updateDBResponse)
    return
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
        var perPage = (event.queryStringParameters && event.queryStringParameters.perPage) ? parseInt(event.queryStringParameters.perPage, 10) : undefined;
        if (!perPage || perPage > 2 * defaultPerPage) {
            perPage = defaultPerPage
        }    

        var PreviousLastEvaluatedKey
        if (event.queryStringParameters && event.queryStringParameters.nextPageKey) {
            let jsonString = Buffer.from(event.queryStringParameters.nextPageKey, 'base64').toString('ascii')
            PreviousLastEvaluatedKey = JSON.parse(jsonString)
        }

        const dataPromise = getRenderings(brand, category, model, perPage, PreviousLastEvaluatedKey)
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayRender(accessLvl, brandSettings[brand])) {
            const msg = "This user isn't allowed to see the list of renderings"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const data = await dataPromise
        const LastEvaluatedKey = data.LastEvaluatedKey
        const renderings = data.Items.map(render => convertStoredRendering(render))
        
        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify(paginate(renderings, perPage, LastEvaluatedKey))
        };

        callback(null, response);
    } catch(error) {
        console.error(`Query for renderings failed. Error ${error}`);
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
        const runningInstancesPromise = findInstances(loocEC2Tag, loocEC2TagRenderValue)
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayRender(accessLvl, brandSettings[brand])) {
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
        const runningInstances = await runningInstancesPromise
        const waitingForFreeInstance = runningInstances.length >= maxRenderInstances
        let timeStamp = (new Date()).getTime()
        const renderStarted = !waitingForFreeInstance ? timeStamp : undefined
        let createDBEntryPromise = createRenderingInDB(brand, category, modelId, parameters, modelS3Key, timeStamp, waitingForFreeInstance, renderStarted)
        let uploadKey = makeUploadKey(brand, category, modelId, timeStamp)
        let saveParametersPromise = writeParametersToS3(parameters, uploadKey)
        console.log("Currently running rendering instances: ", runningInstances.length)
        if (!waitingForFreeInstance) {
            console.log("Starting rendering for model ", modelS3Key, " which will be uploaded to ", uploadKey)
            const instanceStartResponse = await startInstance(modelS3Key, uploadKey)
            console.log(`Success: ${instanceStartResponse.Instances.length} instances started`)
        } else {
            console.log("Maximum instances rendering, waiting for next free instance")
        }
        const updateDBResult = await createDBEntryPromise
        const writeParametersResponse = await saveParametersPromise
        console.log(`Success: db updated: ${JSON.stringify(updateDBResult)}, writeParametersResponse: ${JSON.stringify(writeParametersResponse)}`)

        var response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: `Success: db updated: ${JSON.stringify(updateDBResult)}` 
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

            const ec2pricingPromise = getEC2Pricing()
            const renderingData = await getRenderingFromDB(brand, category, modelId, timeStamp)

            if (!renderingData || !renderingData.Items || renderingData.Items.length == 0) {
                const msg = `Failed to find rendering with brand: ${brand}, category: ${category}, modelId: ${modelId} in DB`
                console.error(msg)
                callback(null, {msg: msg})
                return
            }

            const rendering = convertStoredRendering(renderingData.Items[0])
            const startedTimeStamp = rendering.renderStarted || rendering.created
            const renderingTimeInS = Math.max(60, (finishedTimeStamp - startedTimeStamp) / 1000)
            console.log("Rendering took ", renderingTimeInS, "s")
            const ec2Price = await ec2pricingPromise
            console.log("ec2Price: ", ec2Price)

            const costPerHour = ec2Price || 1.0
            const cost = renderingTimeInS / 3600 * costPerHour

            console.log("Saving receipt for rendering: ", rendering)
            const receiptPromise = saveReceiptInDB(brand, category, modelId, timeStamp, renderingTimeInS, cost, rendering.parameters)
            const updateSuccess = await updateModel(key, brand, category, modelId, timeStamp, finishedTimeStamp, cost)
            const receiptWriteSuccess = await receiptPromise
            console.log("Updating model with finished ", key, " in db success: ", updateSuccess, receiptWriteSuccess)    

            callback(null, {msg: "Success"})
        }
    } catch (error) {
        callback(error, {msg: `Failed to save data because of ${error.toString()}`})
    }
}

// Save the link to the logfile into the db and start new instances if renderings are waiting
exports.savelog = async (event, context, callback) => {
    try {
        for (const index in event.Records) {
            const record = event.Records[index]
            const key = record.s3.object.key
            const keyComponents = key.split('/')
            const brand = keyComponents[0]
            const category = keyComponents[1]
            const modelId = keyComponents[2]
            const timeStamp = keyComponents[3]

            const renderingData = await getRenderingFromDB(brand, category, modelId, timeStamp)

            if (!renderingData || !renderingData.Items || renderingData.Items.length == 0) {
                const msg = `Failed to find rendering with brand: ${brand}, category: ${category}, modelId: ${modelId} in DB`
                console.error(msg)
                callback(null, {msg: msg})
                return
            }
            const updateSuccess = await updateModelLog(key, brand, category, modelId, timeStamp)
            console.log("Updating model with finished ", key, " in db success: ", updateSuccess)    

            callback(null, {msg: "Success"})
        }
    } catch (error) {
        callback(error, {msg: `Failed to save data because of ${error.toString()}`})
    }
}

// Check for waiting renderings when instances are terminated
exports.checkWaiting = async (event, context, callback) => {
    try {
        const instanceID = event.detail['instance-id']
        console.log("Instance ", instanceID, " has been terminated")

        const tagsPromise = ec2.describeTags({ 
            Filters: [{
                Name: "resource-id",
                Values: [instanceID]
            }]
        }).promise()
        const runningInstances = await findInstances(loocEC2Tag, loocEC2TagRenderValue)
        if (runningInstances.length < maxRenderInstances) {
            console.log("Found ", runningInstances.length, " out of max ", maxRenderInstances, " checking for waiting renderings")
            const terminatedInstanceTags = await tagsPromise
            const tag = terminatedInstanceTags.Tags.find(tag => tag.Key === uploadKeyTag);
            const brand = tag && tag.Value && tag.Value.split('/')[0]
            if (brand) {
                await checkForWaitingRenderings(brand)
            }
        } else {
            console.log(runningInstances.length, " instances out of a maximum of ", maxRenderInstances, " instances running, not checking for waiting renderings.")
        }

        callback(null, {msg: "Success"})
    } catch (error) {
        callback(error, {msg: `Failed to save data because of ${error.toString()}`})
    }
}

// Update the status of the current rendering
exports.updateStatus = async (event, context, callback) => {
    try {
        const key = event.s3key
        const status = event.status

        if (!key || !status) {
            const msg = `Expected bot s3key and status parameter`
            console.error(msg)
            callback(null, {msg: msg})
            return
        }

        const keyComponents = key.split('/')
        const brand = keyComponents[0]
        const category = keyComponents[1]
        const modelId = keyComponents[2]
        const timeStamp = keyComponents[3]

        const updateSuccess = await updateRenderingStatus(status, brand, category, modelId, timeStamp)
        console.log("Updating model with finished ", key, " in db success: ", updateSuccess)    

        callback(null, {msg: "Success"})
    } catch (error) {
        callback(error, {msg: `Failed to save data because of ${error.toString()}`})
    }
}

// Delete rendering should the current user have enough rights
exports.delete = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()
    const model = event.pathParameters.model.toLowerCase()
    const timestamp = event.pathParameters.timestamp.toLowerCase()
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    if (!brand || !category || !model || !timestamp) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand,category, model and timestamp in the call.`,
        });
        return;
    }    
    
    console.log("Deleting from ", brand, ", for category: ", category, ", model: ", model, " - ", timestamp)
    try {
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayRender(accessLvl, brandSettings[brand])) {
            const msg = "This user isn't allowed to edit renderings"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }
        const instanceTerminationPromise = findAndTerminate(makeUploadKey(brand, category, model, timestamp))
        const dbDeletionResponse = await deleteRenderingFromDB(brand, category, model, timestamp)
        const terminationResponse = await instanceTerminationPromise
        console.log("dbDeletionResponse: ", dbDeletionResponse, ", terminationResponse: ", terminationResponse)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({ "message": "Deletion of rendering for " + model + " successful" })
        };

        callback(null, response);
    } catch (error) {
        callback(error, {msg: `Failed to delete rendering because of ${error.toString()}`})
    }
}

//  Get the brand's receipts should the current user have enough rights, paginated
exports.receipts = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const year = event.queryStringParameters && event.queryStringParameters.year;
    const month = event.queryStringParameters && event.queryStringParameters.month;
    
    try {
        var PreviousLastEvaluatedKey
        if (event.queryStringParameters && event.queryStringParameters.nextPageKey) {
            let jsonString = Buffer.from(event.queryStringParameters.nextPageKey, 'base64').toString('ascii')
            PreviousLastEvaluatedKey = JSON.parse(jsonString)
        }

        console.log("Checking for receipts for ", brand)
        const dataPromise = getReceipts(brand, year, month, PreviousLastEvaluatedKey)
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayRender(accessLvl, brandSettings[brand])) {
            const msg = "This user isn't allowed to see the list of renderings"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const data = await dataPromise
        const LastEvaluatedKey = data.LastEvaluatedKey
        const receipts = data.Items.map(receipt => convertStoredReceipt(receipt))
        
        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify(paginate(receipts, undefined, LastEvaluatedKey))
        };

        callback(null, response);
    } catch(error) {
        console.error(`Query for receipts failed. Error ${error}`);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};

//  Get the brand's rendering costs for a specified month should the current user have enough rights
exports.costs = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const year = event.queryStringParameters && event.queryStringParameters.year;
    const month = event.queryStringParameters && event.queryStringParameters.month;

    if (!year || !month) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a year and month query parameter in the call.`,
        });
        return;
    }    
    
    try {
        console.log("Checking for receipts for ", brand, " for month: ", month, " and year ", year)
        const dataPromise = getReceipts(brand, year, month)
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayRender(accessLvl, brandSettings[brand])) {
            const msg = "This user isn't allowed to see the list of renderings"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const data = await dataPromise
        const sumUp = (acc, val) => acc + val
        const totalCost = data.Items.length > 0 ? data.Items.map(receipt => receipt.cost).reduce(sumUp) : 0
        
        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({totalCost: totalCost})
        };

        callback(null, response);
    } catch(error) {
        console.error(`Query for totalCost failed. Error ${error}`);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};