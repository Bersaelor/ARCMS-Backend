/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

const defaultPerPage = 20;

function accessLvlMaySeeUsers(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}

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
            } else if (data.Items == undefined || data.Items.length < 1) {
                reject('No user entry for brand \'' + brand + '\' !');
                return;
            } else if (data.Items[0].accessLvl == undefined ) {
                reject('Entry' + data.Items[0] + 'has no accessLvl!');
                return;
            } else {
                resolve(data.Items[0].accessLvl);
            }
        });
    });
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

async function getUsers(brand, perPage, LastEvaluatedKey) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        IndexName: "sk-id-index",
        ProjectionExpression: "id, accessLvl, company, firstName, lastName, address, zipCode, customerId, city, telNr,  maxDevices",
        KeyConditionExpression: "#sk = :value",
        ExpressionAttributeNames:{
            "#sk": "sk"
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#user`,
        },
        Limit: perPage,
    };

    if (LastEvaluatedKey) { params.ExclusiveStartKey = LastEvaluatedKey }

    return dynamoDb.query(params).promise()
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
        const usersPromise = getUsers(brand, perPage, PreviousLastEvaluatedKey);

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
        const users = usersData.Items
        console.log("Query succeeded, found: ", users.length, " users");

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify(paginate(users, perPage, LastEvaluatedKey))
        };
    
        callback(null, response);

    } catch(error) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};
