/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.getAccessLvl = async (cognitoUserName, brand) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "accessLvl",
        KeyConditionExpression: "#id = :v and sk = :b",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":v": cognitoUserName,
            ":b": `${brand}#user`
        }
    };

    return new Promise((resolve, reject) => {
        dynamoDb.query(params, (error, data) => {
            if (error) {
                reject(error);
                return;
            } else if (data.Items == undefined || data.Items.length < 1) {
                reject('No user named "' + cognitoUserName + '" for brand \'' + brand + '\' !');
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

exports.accessLvlMayCreate = (accessLvl) => {
    if (!accessLvl) return false
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}

exports.accessLvlMayRender = (accessLvl, brandSettings) => {
    if (!accessLvl) return false
    // all admins may render
    if (accessLvl == process.env.ACCESS_ADMIN) return true

    if (!brandSettings) return false
    
    if (accessLvl == process.env.ACCESS_MANAGER && brandSettings.allowsRendering) return true
    
    return false
}