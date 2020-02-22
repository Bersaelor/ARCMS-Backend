/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const { getAccessLvl , accessLvlMayCreate} = require('../shared/access_methods')

const getCategorys = async (brand) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#tag`,
        },
    };

    return dynamoDb.query(params).promise()
}

async function createTagInDB(values, brand) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        Item: {
            "id": `${brand}#tag`,
            "sk": values.name
        }
    };

    return dynamoDb.put(params).promise();
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

// all tags for one brand
exports.all = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()

    const data = await getCategorys(brand)

    const tags = data.Items.map(tag => tag.sk)

    console.log("Returning ", tags.length, " tags from DynDB for brand ", brand)

    callback(null, {
        statusCode: 200,
        headers: makeHeader('application/json', 0),
        body: JSON.stringify(tags)
    });
};

// create new tag with name for brand
exports.createNew = async (event, context, callback) => {
    const cognitoUserName = event.requestContext.authorizer.claims["cognito:username"].toLowerCase();
    const brand = event.pathParameters.brand.toLowerCase()
    var body = JSON.parse(event.body)

    try {
        const accessLvlPromise = getAccessLvl(cognitoUserName, brand)

        if (!body.name) {
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json'),
                body: JSON.stringify({ "message": "The new tag needs to have a valid name" })
            });
            return;
        }
        body.name = body.name.toLowerCase()

        // make sure the current cognito user has high enough access lvl
        const accessLvl = await accessLvlPromise;
        if (!accessLvlMayCreate(accessLvl)) {
            const msg = "This user isn't allowed to create or update tags"
            callback(null, {
                statusCode: 403,
                headers: makeHeader('application/json' ),
                body: JSON.stringify({ "message": msg })
            });
            return;
        }

        const updateDBPromise = createTagInDB(body, brand)
        const updateSuccess = await updateDBPromise
        console.log("write Category to db success: ", updateSuccess)

        const response = {
            statusCode: 200,
            headers: makeHeader('application/json' ),
            body: JSON.stringify({
                "message": "Tag creation or update successful"
            })
        };
    
        callback(null, response);

    } catch(error) {
        console.error('Failed to create category: ', JSON.stringify(error, null, 2));
        callback(null, {
            statusCode: error.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: `Encountered error ${error}`,
        });
        return;
    }
};