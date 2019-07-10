/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

async function loadDevicesFromDB(email, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, model",
        KeyConditionExpression: "#id = :value and begins_with(sk, :brand)",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${email}#device`,
            ":brand": brand
        }
    };

    return dynamoDb.query(params).promise()
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

function mapDBEntriesToOutput(brandName, items) {
    let length = brandName.length + 1
    return items.map((value) => {
        return {
            model: value.model,
            id: value.sk.slice(length)
        }
    })
}

exports.all = async (event, context, callback) => {
    if (event.queryStringParameters.brand == undefined) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Missing query parameter 'brand'`,
        });
    }

    const brand = event.queryStringParameters.brand;

    if (!event.requestContext.authorizer) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Cognito Authorization missing`,
        });
    }

    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    try {
        const data = await loadDevicesFromDB(cognitoUserName, brand);
        const devices = mapDBEntriesToOutput(brand, data.Items)
        console.log("Query succeeded, devices: ", devices)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(devices)
        };
    
        callback(null, response);
    } catch(err) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Couldn\'t fetch the brands because of ' + err,
        };
        callback(null, response);
        return;
    }
};
