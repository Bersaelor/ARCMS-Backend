/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const { getAccessLvl, accessLvlMayCreate } = require('shared/access_methods')

const testStage = "test"
const productionStage = "prod"

function makeHeader(content, maxAge = 60) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Cache-Control': `max-age=${maxAge},must-revalidate`,
        'Content-Type': content
    };
}

const getConfig = async (brand, stage) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, headerImage, updateInfo, lastEdited, texts",
        KeyConditionExpression: "#id = :value and #sk = :sk",
        ExpressionAttributeNames:{
            "#id": "id",
            "#sk": "sk"
        },
        ExpressionAttributeValues: {
            ":value": `appconfig`,
            ":sk": `${brand}#${stage}`
        },
    };

    return dynamoDb.query(params).promise()
}

async function createConfigInDB(user, values, brand, stage) {
    const sanitize = (value) => ( value ? value : "placeholder.png" ) 

    let updateInfo 
    if (values.updateInfo) {
        let isString = typeof values.updateInfo === 'string' || values.updateInfo instanceof String
        updateInfo = isString ? values.updateInfo : JSON.stringify(values.updateInfo)
    } else {
        updateInfo = "{}"
    }

    let texts
    if (values.texts) {
        let isString = typeof values.texts === 'string' || values.texts instanceof String
        texts = isString ? values.texts : JSON.stringify(values.texts)
    } else {
        texts = "{}"
    }
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `appconfig`,
            "sk": `${brand}#${stage}`,
            "headerImage": sanitize(values.headerImage),
            "updateInfo": updateInfo,
            "texts": texts
        }
    };
    params.Item.lastEdited = `${user}#${(new Date()).toISOString()}`

    return dynamoDb.put(params).promise();
}

async function getSignedImageUploadURL(key, type) {
    var params = {
        Bucket: process.env.IMAGE_BUCKET,
        Key: key,
        ContentType: type,
        Expires: 600,
        ACL: 'public-read',
    }

    return new Promise(function (resolve, reject) {
        s3.getSignedUrl('putObject', params, function (err, url) { 
            if (err) reject(err)
            else resolve(url); 
        });
    });
}

const convertStoredConfig = (storedConfig) => {
    var config = storedConfig
    delete storedConfig.sk
    try {
        config.updateInfo = storedConfig.updateInfo ? JSON.parse(storedConfig.updateInfo) : {}
        config.texts = storedConfig.texts ? JSON.parse(storedConfig.texts) : {}
    } catch (error) {
        console.log("Failed to convert json because: ", error)
    }
    config.headerImage = "https://images.looc.io/" + storedConfig.headerImage
    return config
}

const fileExtension = (filename) => {
    return filename.split('.').pop();		
}

// Get the app config, by default returns live, if specified the testing one
exports.get = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const testing = event.queryStringParameters && event.queryStringParameters.testing;
    const showTestingContent = testing && testing === "true"
    const stage = showTestingContent ? testStage : productionStage

    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand in the call.`,
        });
        return;
    }    
    
    console.log("Checking for appconfig for ", brand, ", showTesting? ", showTestingContent)
    try {
        const data = await getConfig(brand, stage)
        const model = data.Count > 0 ? convertStoredConfig(data.Items[0]) : undefined
    
        var response
        if (model) {
            response = {
                statusCode: 200,
                headers: makeHeader('application/json'),
                body: JSON.stringify(model)
            };
        } else {
            response = {
                statusCode: 404,
                headers: makeHeader('application/json'),
                body: JSON.stringify({ message: `No config found for brand ${brand}` })
            };
        }

        callback(null, response);
    } catch(error) {
        console.error('Query failed to delete. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;

    }
};

// Post a new app configuration, overwriting the old testing one
exports.new = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()

    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand in the call.`,
        });
        return;
    }    

    var body = JSON.parse(event.body)

    const headerImageUploadRequested = body.headerImageName
    const headerImageType = body.headerimageType
    delete body.headerImageName
    delete body.headerimageType

    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)

        if ((!headerImageUploadRequested && !body.headerImage) || !body.updateInfo) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": "The new should have a headerImage and an updateInfo" })
            });
            return;
        }

        // make sure the current cognito user has high enough access lvl
        const accessLvl = await accessLvlPromise;
        if (!accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to create or update config"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        console.log("body: ", body, " headerImageUploadRequested? ", headerImageUploadRequested)

        var imageURLPromise
        if (headerImageUploadRequested) {
            const now = new Date()
            const imageFileFolder = `appconfig-${brand}-${now.getTime()}`
            const imageFileName = `${imageFileFolder}.${fileExtension(headerImageUploadRequested)}`
            const imageKey = `${imageFileFolder}/${imageFileName}`
            body.headerImage = imageKey
            imageURLPromise = getSignedImageUploadURL(imageKey, headerImageType)
        } else if (body.headerImage && body.headerImage.startsWith("http")) {
            // remove the host from as we store only the headerImage key in the db
            var url = new URL(body.headerImage)
            var path = url.pathname
            if (path.startsWith("/")) path = path.slice(1)
            body.headerImage = path
        }

        const writeDBPromise = createConfigInDB(cognitoUserName, body, brand, testStage)
        const headerImageUploadURL = imageURLPromise ? await imageURLPromise : undefined
        const writeSuccess = await writeDBPromise
        console.log("write config to db success: ", writeSuccess)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                message: "Config creation or update successful",
                headerImageUploadURL: headerImageUploadURL ? headerImageUploadURL : "",
            })
        };
        callback(null, response);
    } catch(error) {
        console.error('Failed to create config: ', error);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};

// Copy the current testing config to production
exports.publish = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()

    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand in the call.`,
        });
        return;
    }    

    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)
        const existingDataPromise = await getConfig(brand, testStage)

        // make sure the current cognito user has high enough access lvl
        const accessLvl = await accessLvlPromise;
        if (!accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to create or update config"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const existingData = await existingDataPromise

        const existingTestConfig = existingData.Count > 0 ? existingData.Items[0] : undefined
        console.log("Publishing textconfig ", existingTestConfig, " of brand ", brand)
        if (!existingTestConfig) {
            callback(null, {
                statusCode: 404,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": `No existing ${testStage} appconfig for ${brand} found` })
            });
            return;
        }

        const writeDBPromise = createConfigInDB(cognitoUserName, existingTestConfig, brand, productionStage)
        const writeSuccess = await writeDBPromise
        console.log("write config to db success: ", writeSuccess)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                message: "Config publish successful",
            })
        };
        callback(null, response);
    } catch(error) {
        console.error('Failed to publish config: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};