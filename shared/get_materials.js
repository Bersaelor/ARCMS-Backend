/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.getMaterials = async (brand, type, identifier, perPage, LastEvaluatedKey) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Limit: perPage,
        ProjectionExpression: "sk, localizedNames, #p, #s, lastEdited, image, normalTex",
        ExpressionAttributeNames: {
            "#id": "id",
            "#s": "status",
            "#p": "parameters"
        },
    };
    if (type) {
        params.KeyConditionExpression = "#id = :id and begins_with(#sk, :sk)"
        params.ExpressionAttributeValues = {
            ":id": `material#${brand}`,
            ":sk": identifier ? `${type}#${identifier}` : type
        }
        params.ExpressionAttributeNames["#sk"] = "sk"
    } else {
        params.KeyConditionExpression = "#id = :id"
        params.ExpressionAttributeValues = {
            ":id": `material#${brand}`
        }
    }

    if (LastEvaluatedKey) { params.ExclusiveStartKey = LastEvaluatedKey }

    return dynamoDb.query(params).promise()
}