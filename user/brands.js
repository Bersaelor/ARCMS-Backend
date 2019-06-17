/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.get = (event, context, callback) => {

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

    dynamoDb.query(params, (err, data) => {
        if (err) {
            console.error('Query failed to load data. Error JSON: ', JSON.stringify(err, null, 2));
            const response = {
                statusCode: err.statusCode || 501,
                headers: { 'Content-Type': 'text/plain' },
                error: err,
                body: 'Couldn\'t fetch the brands',
            };
            callback(null, response);
            return;
        }

        const brands = data.Items.map( x => x.sk.slice(0 , -5) );
        console.log("Query succeeded, brands: ", brands);

        const response = {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brands: brands })
        };
    
        callback(null, response);
    });
};
