/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const { getAccessLvl } = require('../shared/access_methods')

const defaultPerPage = 20;

function accessLvlMaySeeUsers(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

async function getUsers(brand, perPage, LastEvaluatedKey, filter) {
    const shouldFilter = filter && filter.length > 1
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        IndexName: "sk-id-index",
        ProjectionExpression: "id, accessLvl, company, firstName, lastName, address, zipCode, customerId, city, telNr, mailCC, maxDevices",
        KeyConditionExpression: shouldFilter ? "#sk = :value and begins_with(id, :filter)" : "#sk = :value",
        ExpressionAttributeNames:{
            "#sk": "sk"
        },
        ExpressionAttributeValues: shouldFilter ?
         { ":value": `${brand}#user`, ":filter": filter } 
         : { ":value": `${brand}#user`, },
        Limit: perPage,
    };

    if (LastEvaluatedKey) { params.ExclusiveStartKey = LastEvaluatedKey }

    return dynamoDb.query(params).promise()
}

async function getLastUsed(brand, email) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "lastUsed",
        KeyConditionExpression: "#id = :value and begins_with(sk, :brand)",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": `${email}#device`,
            ":brand": brand
        },
    };

    return dynamoDb.query(params).promise().then( val => {
        const lastUsedArray = val.Items.map( (item) => item.lastUsed ).sort()
        return lastUsedArray.length > 0 ? lastUsedArray[lastUsedArray.length - 1] : undefined
    });
}

function paginate(orders, perPage, LastEvaluatedKey) {
    if (LastEvaluatedKey) {
        const base64Key = Buffer.from(JSON.stringify(LastEvaluatedKey)).toString('base64')
        return {
            items: orders,
            itemCount: orders.length,
            fullPage: perPage,
            hasMoreContent: LastEvaluatedKey !== undefined,
            nextPageKey: base64Key 
        }
    } else {
        return {
            items: orders,
            itemCount: orders.length,
            fullPage: perPage,
            hasMoreContent: false,
        }
    }
}

exports.all = async (event, context, callback) => {
    if (event.queryStringParameters.brand == undefined) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Missing query parameter 'brand'`,
        });
    }

    const brand = event.queryStringParameters.brand;
    const filter = event.queryStringParameters.filter;

    if (!event.requestContext.authorizer) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Cognito Authorization missing`,
        });
    }
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    try {
        // make sure the current cognito user has high enough access lvl to get see all users for this brand
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);

        var perPage = event.queryStringParameters.perPage ? parseInt(event.queryStringParameters.perPage, 10) : undefined;
        if (!perPage || perPage > 2 * defaultPerPage) {
            perPage = defaultPerPage
        }    

        var PreviousLastEvaluatedKey
        if (event.queryStringParameters.nextPageKey) {
            let jsonString = Buffer.from(event.queryStringParameters.nextPageKey, 'base64').toString('ascii')
            PreviousLastEvaluatedKey = JSON.parse(jsonString)
        }

        // fetch the users for the brand
        const usersPromise = getUsers(brand, perPage, PreviousLastEvaluatedKey, filter);

        const accessLvl = await accessLvlPromise;
        if (!accessLvlMaySeeUsers(accessLvl)) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `User ${cognitoUserName} is not allowed to list all users of brand ${brand}`,
            });
            return;
        }
        const usersData = await usersPromise;
        const LastEvaluatedKey = usersData.LastEvaluatedKey
        var users = usersData.Items
        console.log(`Query for brand ${brand} succeeded, found: ${users.length} users`);

        const lastUsedPromises = users.map( (user, index) => {
            return getLastUsed(brand, user.id).then( lastUsed => { 
                return lastUsed ? { index: index, lastUsed: lastUsed} : undefined
            })
        })

        let lastUsedData = await Promise.all(lastUsedPromises)
        lastUsedData.forEach(value => {
            if (value) users[value.index].lastUsed = value.lastUsed
        })

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify(paginate(users, perPage, LastEvaluatedKey))
        };
    
        callback(null, response);

    } catch(error) {
        console.error('Query failed to load data. Error: ', error);
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};
