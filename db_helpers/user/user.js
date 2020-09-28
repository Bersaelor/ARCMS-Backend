/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const defaultPerPage = 100;

async function getUsers(brand, perPage, LastEvaluatedKey) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        IndexName: "sk-id-index",
        ProjectionExpression: "id, sk",
        KeyConditionExpression: "#sk = :value",
        ExpressionAttributeNames:{
            "#sk": "sk"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#user`
        },
        Limit: perPage,
    };

    if (LastEvaluatedKey) { params.ExclusiveStartKey = LastEvaluatedKey }

    return dynamoDb.query(params).promise()
}

async function updateColumn(columnName, value, id, sk) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Key: {id: id, sk: sk },
        UpdateExpression: 'set #column = :value',
        ExpressionAttributeNames: {'#column' : columnName},
        ExpressionAttributeValues: {
            ':value' : value,
        },
        ReturnValues: "ALL_NEW"
    };

    return dynamoDb.update(params).promise()
}

// Update all user entries of a given brand with a given value in a given column
exports.updateColumn = async (event, context, callback) => {

    const brand = event.brand
    const value = event.value
    const column = event.column

    if (!brand || !value || !column) {
        callback(null, {
            statusCode: 403,
            body: `JSON data should have a brand, value and column`,
        });
        return;
    }

    try {
        var LastEvaluatedKey
        var users = []
        do {
            const data = await getUsers(brand, defaultPerPage, LastEvaluatedKey)
            LastEvaluatedKey = data.LastEvaluatedKey
            users = users.concat(data.Items)
        } while (LastEvaluatedKey !== undefined)

        console.log(`Found ${users.length} users, updating column "${column}" to be "${value}" `)

        var updates = 0
        for (let index = 0; index < users.length; index++) {
            const user = users[index]
            const data = await updateColumn(column, value, user.id, user.sk)
            updates += 1
        }

        callback(null, {
            body: `Updated ${updates} db rows`,
        });
    } catch(error) {
        console.error('Query failed to load data. Error: ', error);
        callback(null, {
            statusCode: error.statusCode || 501,
            body: `Encountered error ${error}`,
        });
        return;
    }
}