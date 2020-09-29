/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const { getAccessLvl, accessLvlMayCreate } = require('shared/access_methods')
const { paginate } = require('shared/pagination')

const defaultPerPage = 80;

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

const fetchStoresForBrand = async (brand, perPage, user, PreviousLastEvaluatedKey) => {
    const params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, address, zipCode, city, country, telNr, email",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#store`
        },
        Limit: perPage,
    }; 
    if (PreviousLastEvaluatedKey) { params.ExclusiveStartKey = PreviousLastEvaluatedKey }
    if (user) {
        params.KeyConditionExpression = "#id = :value and begins_with(sk, :user)"
        params.ExpressionAttributeValues = {
            ":value": `${brand}#store`,
            ":user": `${user}#`
        }
    }
    const data = await dynamoDb.query(params).promise()
    const stores = data.Items && data.Items.map(convertStoredModel)
    return { LastEvaluatedKey: data.LastEvaluatedKey, stores: stores }
}

const deleteStore = async (brand, sk) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {
            "id": `${brand}#store`,
            "sk": sk
        } 
    };

    return dynamoDb.delete(params).promise()
}

const updateStores = async (brand, user, newStores, storesToDelete) => {
    const id = `${brand}#store`

    const puts = newStores.map((store, index) => {
        return {
            PutRequest: {
                Item: {
                    "id": { "S": id },
                    "sk": { "S": `${user}#${index}` },
                    "address": { "S": store.address || "" },
                    "zipCode": { "S": store.address || "" },
                    "city": { "S": store.address || "" },
                    "country": { "S": store.address || "" },
                    "telNr": { "S": store.address || "" },
                    "email": { "S": store.address || "" },
                }
            }
        }
    })
    const deletes = storesToDelete.map((store) => {
        return {
            DeleteRequest: {
                "id": store.id,
                "sk": store.sk
            }
        }
    })
    var params = {
        RequestItems: {
            [process.env.CANDIDATE_TABLE]: [ ...puts, ...deletes]
        }
    }
    console.log("Params: ", params)
    return dynamoDb.batchWrite(params).promise()
}

const convertStoredModel = (storedModel) => {
    var model = storedModel
    return model
}


// Get an array of stores, given a brand and optionally user, paginated
exports.get = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const user = event.queryStringParameters && event.queryStringParameters.user;
    var PreviousLastEvaluatedKey
    if (event.queryStringParameters.nextPageKey) {
        let jsonString = Buffer.from(event.queryStringParameters.nextPageKey, 'base64').toString('ascii')
        PreviousLastEvaluatedKey = JSON.parse(jsonString)
    }

    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Expected a brand in the call.`,
        });
        return;
    }

    try {
        var perPage = event.queryStringParameters.perPage ? parseInt(event.queryStringParameters.perPage, 10) : undefined;
        if (!perPage || perPage > 4 * defaultPerPage) {
            perPage = 4 * defaultPerPage
        }

        console.log("Fetching stores for brand ", brand, " and user ", user)
        const data = await fetchStoresForBrand(brand, perPage, user, PreviousLastEvaluatedKey)

        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify(paginate(data.stores, perPage, data.LastEvaluatedKey))
        });
    } catch(err) {
        console.error('Query failed to load data. Error: ', error);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}

// Post an array of stores for a given user and brand
exports.new = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    const user = event.pathParameters.user.toLowerCase()
    var newStores = JSON.parse(event.body)

    try {
        // fetch the existing entries, to determine whether entries have to be removed
        const dataPromise = fetchStoresForBrand(brand, defaultPerPage, user, undefined)
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);
        // make sure the current cognito user has high enough access lvl
        const accessLvl = await accessLvlPromise
        // users who aren't managers can update their own store entries
        if (!accessLvlMayCreate(accessLvl) && cognitoUserName.toLowerCase() !== user.toLowerCase()) {
            const msg = `user ${cognitoUserName} isn't allowed to create or update categories for ${user}`
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json'),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const oldStores = (await dataPromise).stores
        const storesToDelete = oldStores.length > newStores.length ? oldStores.slice(newStores.length) : []
        console.log(`Overwriting ${newStores.length}, deleting ${storesToDelete} old stores`)
        const status = await updateStores(brand, user, newStores, storesToDelete)
        console.log("Status response: ", status)
        callback(null, {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": `Updated ${newStores.length}, deleted ${storesToDelete} old stores`,
            })
        });
    } catch (error) {
        console.error('Query failed to load data. Error: ', error);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
}

// Delete store from the db
exports.delete = async (event, context, callback) => {

}