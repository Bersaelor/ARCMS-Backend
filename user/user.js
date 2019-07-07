/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

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

function accessLvlMayCreateUsers(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

exports.createNew = async (event, context, callback) => {

    let cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    let body = JSON.parse(event.body)
    let brand = body.brand;
    let accessLvl = body.accessLvl;
    
    console.log("event.body: ", body);

    console.log("cognitoUserName: ", cognitoUserName, " brand: ", brand);

    try {
        // TODO: Proper error messages for all kinds of missing body values

        console.log("Checking whether it's allowed to create user with accessLvl: ", accessLvl)
        if (!accessLvl || (accessLvl !== process.env.ACCESS_STORE && accessLvl !== process.env.ACCESS_MANAGER)) {
            console.log(`Access lvl is neither ${process.env.ACCESS_STORE} nor ${process.env.ACCESS_MANAGER}`)
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `New Users need to have a valid access lvl of "${process.env.ACCESS_STORE}" or "${process.env.ACCESS_MANAGER}"`,
            });
            return;
        }

        // make sure the current cognito user has high enough access lvl
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand);

        const ownAccessLvl = await accessLvlPromise;
        if (!accessLvlMayCreateUsers(ownAccessLvl)) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('text/plain'),
                body: `User ${cognitoUserName} is not allowed to create users for ${brand}`,
            });
            return;
        }


        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({"message: ": "User creation allowed"})
        };
    
        callback(null, response);

    } catch(error) {
        console.error('Failed to create user: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};
