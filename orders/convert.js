/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();


async function loadUserOrdersFromDB(brand, email, perPage = 50) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk, contact, orderJSON",
        KeyConditionExpression: "#id = :value and begins_with(sk, :user)",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#order`,
            ":user": email
        },
        Limit: perPage,
        ScanIndexForward: false
    };

    return dynamoDb.query(params).promise()
}

async function loadAllOrdersFromDB(brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk, sk2, contact, orderJSON",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#order`,
        },
        ScanIndexForward: false
    };

    return dynamoDb.query(params).promise()
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

function convertOrder(originalOrder) {
    if (originalOrder.sk2) {
        // order is already correct, not converting
        return originalOrder
    }

    const brand = originalOrder.id.split('#')[0]
    const email = originalOrder.sk.split('#')[0]
    const timeString = originalOrder.sk.split('#')[1]

    return {
        "id": `${brand}#order`,
        "sk": `${email}#${timeString}`,
        "sk2": `${timeString}#${email}`,
        "contact": originalOrder.contact,
        "orderJSON": originalOrder.orderJSON
    }
}

function changeUser(originalOrder, toUser) {
    const timeString = originalOrder.sk.split('#')[1]

    return {
        "id": originalOrder.id,
        "sk": `${toUser}#${timeString}`,
        "sk2": `${timeString}#${toUser}`,
        "contact": originalOrder.contact,
        "orderJSON": originalOrder.orderJSON
    }
}

async function writeOrder(order) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: order
    };

    return dynamoDb.put(params).promise();
}

// Copy all orders by one user to a different user, typically to generate a larger data set
exports.copyFromTo = async (event, context, callback) => {

    const brand = event.queryStringParameters.brand;
    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `brand query parameter missing`,
        });
        return;
    }

    const from = event.queryStringParameters.from;
    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `from query parameter missing`,
        });
        return;
    }

    const toUser = event.queryStringParameters.to;
    if (!toUser) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `to query parameter missing`,
        });
        return;
    }

    try {
        const data = await loadUserOrdersFromDB(brand, from)

        const writePromises = data.Items.map((order) => {
            const newOrder = changeUser(order, toUser)
            return writeOrder(newOrder)
        })

        const combinedWritePromise = Promise.all(writePromises)
        const writeResult = await combinedWritePromise

        const response = {
            statusCode: 200,
            headers: makeHeader('text/plain'),
            body: `Successfully finished ${writePromises.length} writes`
        };
        callback(null, response);

    } catch(err) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Failed to convert orders because of ' + err,
        };
        callback(null, response);
        return;
    }
}

// Convert all existing orders to new version structure in DynamoDB
exports.convertAll = async (event, context, callback) => {

    const brand = event.queryStringParameters.brand;

    if (!brand) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `brand query parameter missing`,
        });
        return;
    }

    try {
        const data = await loadAllOrdersFromDB(brand)

        const writePromises = data.Items.map((order) => {
            const newOrder = convertOrder(order)
            return writeOrder(newOrder)
        })

        const combinedWritePromise = Promise.all(writePromises)
        const writeResult = await combinedWritePromise

        const response = {
            statusCode: 200,
            headers: makeHeader('text/plain'),
            body: `Successfully finished ${writePromises.length} writes`
        };
        callback(null, response);

    } catch(err) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Failed to convert orders because of ' + err,
        };
        callback(null, response);
        return;
    }
}