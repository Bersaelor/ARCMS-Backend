/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const { getAccessLvl, accessLvlMayRender } = require('shared/access_methods')
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
        ProjectionExpression: "sk",
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

const convertStoredModel = (storedModel) => {
    var model = storedModel
    delete model.id
    delete model.sk
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

}

// Delete store from the db
exports.delete = async (event, context, callback) => {

}