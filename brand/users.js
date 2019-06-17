/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.all = async (event, context, callback) => {

    var cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    console.log("Querying table for ", cognitoUserName);

    try {
        const data = await getAccessLvl(cognitoUserName, 'grafix');

        const brands = data.Items.map( x => x.accessLvl );
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
        ProjectionExpression: "accessLvl",
        KeyConditionExpression: "#id = :value and sk = :brand",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": cognitoUserName,
            ":brand": `${brand}#user`
        }
    };

    return new Promise((resolve, reject) => {
        dynamoDb.query(params, (error, data) => {
            if (error) {
                reject(error);
                return;
            }

            resolve(data);
        });
    });
}
