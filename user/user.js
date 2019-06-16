/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.get = async function(event, context, callback){

    var cognitoUserName = event.requestContext.authorizer.claims["cognito:username"];

    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk"
    };

    console.log("Scanning table");

    const onScan = (err, data) => {
        if (err) {
            console.error('Scan failed to load data. Error JSON: ', JSON.stringify(err, null, 2));
            callback(err);
        } else {
            console.log("Scan succeeded.");

            const response = {
                statusCode: 200,
                headers: {
                    "x-custom-header" : "My Header Value"
                },
            body: JSON.stringify({ 
                    message: "Hello World!",
                    cognitoUserName: cognitoUserName,
                    items: data.Items
                })
            };
        
            return callback(null, response);
        }
    };

    dynamoDb.scan(params, onScan);  
};
