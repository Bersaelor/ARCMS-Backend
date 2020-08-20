/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const { getAccessLvl, accessLvlMayCreate } = require('shared/access_methods')
const { paginate } = require('shared/pagination')
const brandSettings = require('brand_settings.json')
const defaultPerPage = 20;

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

const getMaterials = async (brand, type, perPage, LastEvaluatedKey) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Limit: perPage,
        ProjectionExpression: "sk, localizedNames, #p, #s, lastEdited",
        ExpressionAttributeNames: {
            "#id": "id",
            "#s": "status",
            "#p": "parameters"
        },
        ExpressionAttributeValues: {
            ":id": `material#${brand}`,
            ":sk": type ? `${type}` : ""
        },
    };
    if (type) {
        params.KeyConditionExpression = "#id = :id and begins_with(#sk, :sk)"
        params.ExpressionAttributeValues = {
            ":id": `material#${brand}`,
            ":sk": type ? `${type}` : ""
        }
        params.ExpressionAttributeNames["#sk"] = "sk"
    } else {
        params.KeyConditionExpression = "#id = :id"
        params.ExpressionAttributeValues = {
            ":id": `material#${brand}`
        }
    }

    params.ScanIndexForward = false
    if (LastEvaluatedKey) { params.ExclusiveStartKey = LastEvaluatedKey }

    return dynamoDb.query(params).promise()
}

const convertStoredMaterial = (stored) => {
    var converted = stored
    let skComponents = stored.sk.split('#')
    converted.type = skComponents[0]
    converted.identifier = skComponents[1]
    delete converted.sk
    try {
        converted.localizedNames = converted.localizedNames ? JSON.parse(converted.localizedNames) : undefined
        converted.parameters = stored.parameters ? JSON.parse(stored.parameters) : {}
    } catch (error) {
        console.log("Failed to convert json because: ", error)
    }

    return converted
}

async function createMatInDB(user, values, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `material#${brand}`,
            "sk": `${values.type}#${values.identifier}`,
            "localizedNames": values.localizedNames ? JSON.stringify(values.localizedNames) : "{}",
            "parameters": values.parameters ? JSON.stringify(values.parameters) : "{}",
            "status": values.status ? values.status : "unpublished"
        }
    };
    params.Item.lastEdited = `${user}#${(new Date()).toISOString()}`

    return dynamoDb.put(params).promise();
}

async function deleteMatFromDB(brand, type, identifier) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {
            "id": `brand#${brand}`,
            "sk": `${type}#${identifier}`
        } 
    };

    return dynamoDb.delete(params).promise()
}

// Get an array of materials, optionally filtered by type, paginated
exports.get = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const type = event.queryStringParameters && event.queryStringParameters.type;

    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand in the call.`,
        });
        return;
    }    
    
    console.log("Checking for materials for ", brand, " of type: ", type)
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

        const dataPromise = getMaterials(brand, type, perPage, PreviousLastEvaluatedKey)
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await getAccessLvl(cognitoUserName, brand);
        if (!accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to see the list of materials"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const data = await dataPromise
        const LastEvaluatedKey = data.LastEvaluatedKey
        const materials = data.Items.map(mat => convertStoredMaterial(mat))
        
        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify(paginate(materials, perPage, LastEvaluatedKey))
        };

        callback(null, response);
    } catch(error) {
        console.error(`Query for materials failed. Error ${error}`);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};

// Post the configuration for a new material
exports.new = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    const body = JSON.parse(event.body)
    const identifier = body.identifier
    const type = body.type

    if (!brand || !identifier || !type) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand, identifier and type in the call.`,
        });
        return;
    }    

    console.log("Creating material for: ", brand, ", ", identifier, ", type: ", type)
    try {
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

        let createDBEntryPromise = createMatInDB(cognitoUserName, body, brand)
        const updateDBResult = await createDBEntryPromise
        console.log(`Success: db updated: ${JSON.stringify(updateDBResult)}`)

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

// Delete material should the current user have enough rights
exports.delete = async (event, context, callback) => {
    let cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const type = event.pathParameters.type.toLowerCase()
    const id = event.pathParameters.id.toLowerCase()

    if (!id || !brand || !type) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected both a brand, modelname and a category, one is missing.`,
        });
        return;
    }

    console.log(cognitoUserName, " wants to delete material named: ", id, " from brand ", brand)
    try {
        // make sure the current cognito user has high enough access lvl
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);

        const ownAccessLvl = await accessLvlPromise;
        if (!accessLvlMayCreate(ownAccessLvl)) {
            const msg = `User ${cognitoUserName} is not allowed to delete models of ${brand}`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const dbDeletionResponse = await deleteMatFromDB(brand, type, id)
        console.log("dbDeletionResponse: ", dbDeletionResponse)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({ "message": "Deletion of material " + type + id + " successful" })
        };

        callback(null, response);
    } catch (error) {
        console.error('Query failed to delete. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}