/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const brandSettings = require('../brand_settings.json')
const { accessLvlMayCreate, accessLvlMayRender } = require('../shared/access_methods')


async function getBrands(cognitoName) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, accessLvl, firstName, lastName, company, address, zipCode, city, telNr, maxDevices",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": cognitoName
        }
    };

    return dynamoDb.query(params).promise().then( (data) => {
        return data.Items.map( (value) => {
            const brand = value.sk.slice(0 , -5)
            const allows3DUpload = (brandSettings[brand] && brandSettings[brand].allows3DModelUpload) || false
            value.brand = brand
            value.brandDisplayName = (brandSettings[brand] && brandSettings[brand].name) || brand
            value.mayEditManagers = accessLvlMayEditManagers(value.accessLvl)
            value.mayEditStores = accessLvlMayEditStores(value.accessLvl)
            value.mayEditFrames = accessLvlMayCreate(value.accessLvl)
            value.mayRender = accessLvlMayRender(value.accessLvl, brandSettings[brand])
            value.role = value.accessLvl
            value.allows3DUpload = allows3DUpload
            delete(value.sk)
            delete(value.accessLvl)
            return value
        });
    });
}

function accessLvlMayEditManagers(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN;
}

function accessLvlMayEditStores(accessLvl) {
    return accessLvl == process.env.ACCESS_ADMIN || accessLvl == process.env.ACCESS_MANAGER;
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

exports.get = async (event, context, callback) => {

    if (!event.requestContext.authorizer) {
        callback(null, {
            statusCode: 403,
            headers: makeHeader('text/plain'),
            body: `Cognito Authorization missing`,
        });
    }
    var cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();

    try {
        const brands = await getBrands(cognitoUserName);
        console.log("Query succeeded, brands: ", brands);

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json'),
            body: JSON.stringify(brands)
        };
    
        callback(null, response);
    } catch(err) {
        console.error('Query failed to load data. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Couldn\'t fetch the brands because of ' + err,
        };
        callback(null, response);
        return;
    }
};
