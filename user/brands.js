/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

async function getBrands(cognitoName) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, accessLvl",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": cognitoName
        }
    };

    return dynamoDb.query(params).promise().then( (data) => {
        return data.Items.map( (value) => {
            return { 
                brand: value.sk.slice(0 , -5),
                role: value.accessLvl,
                mayEditManagers: accessLvlMayEditManagers(value.accessLvl),
                mayEditStores: accessLvlMayEditStores(value.accessLvl),
                mayEditFrames: accessLvlMayEditFrames(value.accessLvl)
            };
        });
    });
}

function accessLvlMayEditManagers(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN;
}

function accessLvlMayEditStores(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}

function accessLvlMayEditFrames(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}


function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

exports.get = async (event, context, callback) => {

    var cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    try {
        const brands = await getBrands(cognitoUserName);
        console.log("Query succeeded, brands: ", brands);

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify({ brands: brands })
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
