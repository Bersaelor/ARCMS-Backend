/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const defaultPerPage = 30;
const { fetchCoordinates } = require('shared/get_geocoordinates')

async function getUsers(brand, perPage, LastEvaluatedKey) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        IndexName: "sk-id-index",
        ProjectionExpression: "id, sk, company, address, zipCode, city, country, telNr",
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

async function createStore(brand, user, location) {
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
    if (location && location.lat) params.Item.lat = location.lat
    if (location && location.lng) params.Item.lng = location.lng

    return dynamoDb.put(params).promise();
}

const fetchLocation = async (user) => {
    if (user.address && user.zipCode && user.city) {
        return fetchCoordinates(user)
    } else {
        console.log(`Can't fetch address for user ${user.id}`)
        return undefined
    }
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
            const location = await fetchLocation(user)
            const data = await createStore(brand, user, location)
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