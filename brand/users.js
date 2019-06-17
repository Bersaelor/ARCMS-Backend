/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.all = async (event, context, callback) => {

    var cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": cognitoUserName
        }
    };

    console.log("Querying table for ", cognitoUserName, 'params: ', params);

    try {
        const data = await getAccessLvl();

        const brands = data.Items.map( x => x.sk.slice(0 , -5) );
        console.log("Query succeeded, brands: ", brands);

        const response = {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(brands)
        };
    
        callback(null, response);

    } catch(error) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(error, null, 2));
        const response = {
            statusCode: error.statusCode || 501,
            headers: { 'Content-Type': 'text/plain' },
            body: `Encountered error ${error}`,
        };
        callback(null, response);
        return;
    }
};

async function getAccessLvl(cognitoUserName, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": cognitoUserName
        }
    };

    return dynamoDb.query(params).promise();
}
