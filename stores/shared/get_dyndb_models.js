/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.getModels = async (brand, category) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, image, modelFile, dxfFile, svgFile, usdzFile, #s, localizedNames, props",
        KeyConditionExpression: "#id = :value and begins_with(sk, :category)",
        ExpressionAttributeNames:{
            "#id": "id",
            "#s": "status"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#model`,
            ":category": `${category}#`
        },
    };

    return dynamoDb.query(params).promise()
}

exports.getAllModels = async (brand) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, image, modelFile, dxfFile, svgFile, usdzFile, #s, localizedNames, props",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id",
            "#s": "status"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#model`,
        },
    };

    return dynamoDb.query(params).promise()
}

exports.getCategorys = async (brand) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, image, #s, localizedTitles, localizedDetails",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id",
            "#s": "status"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#category`,
        },
    };

    return dynamoDb.query(params).promise()
}