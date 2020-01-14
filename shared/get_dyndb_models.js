/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.getModels = async (brand, category) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, image, modelFile, usdzFile, #s, localizedNames, props",
        KeyConditionExpression: "#id = :value and begins_with(sk, :category)",
        ExpressionAttributeNames:{
            "#id": "id",
            "#s": "status"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#model`,
            ":category": category
        },
    };

    return dynamoDb.query(params).promise()
}