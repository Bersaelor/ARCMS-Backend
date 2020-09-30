/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const defaultPerPage = 100;

async function getUsers(brand, perPage, LastEvaluatedKey) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        IndexName: "sk-id-index",
        ProjectionExpression: "id, sk, company, address, zipCode, city, country, telnr",
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

async function createStore(brand, user) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `${brand}#store`,
            "sk": `${user.id}#0`,
            "company": user.company,
            "address": user.address,
            "zipCode": user.zipCode,
            "city": user.city,
            "country": user.country,
            "telNr": user.telNr,
            "email": user.id
        }
    };

    return dynamoDb.put(params).promise();
}

// Create a store entry for every user, copying the users settings
exports.createDefaultStore = async (event, context, callback) => {
    const brand = event.brand

    if (!brand) {
        callback(null, {
            statusCode: 403,
            body: `JSON data should have a brand`,
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

        console.log(`Found ${users.length} users, creating as many stores`)

        var updates = 0
        for (let index = 0; index < users.length; index++) {
            const user = users[index]
            const data = await createStore(brand, user)
            updates += 1
        }

        callback(null, {
            body: `Created ${updates} store entries`,
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