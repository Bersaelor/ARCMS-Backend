/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const fs = require("fs");
const strings = require('./locales.js');

async function getModel(brand, category, modelName) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, dxfFile, svgFile, props",
        KeyConditionExpression: "#id = :value and #sk = :searchKey",
        ExpressionAttributeNames:{
            "#id": "id",
            "#sk": "sk",
        },
        ExpressionAttributeValues: {
            ":value": `${brand}#model`,
            ":searchKey": `${category}#${modelName}`
        },
    };

    return dynamoDb.query(params).promise()
}


// Send email with a number of created dxf files for the ordered frames
exports.newRequest = async (event, context, callback) => {

    const firstRecord = event.Records[0]
    if (!firstRecord || !firstRecord.Sns) {
        throw "Failed to get firstRecord or Sns entry"
    }
    const message = firstRecord.Sns
    const frames = JSON.parse(message.Message)
    const brand = message.MessageAttributes.brand.Value
    const orderSK = message.MessageAttributes.orderSK.Value
    if (!frames || !brand || !orderSK || !Array.isArray(frames)) {
        throw "Failed to get bodyJSON, brand, orderSK entry"
    }

    console.log("Received order-notification ", orderSK, " for brand ", brand, " need to create DXF models")

    console.log("frames: ", frames)
    // const mailToManufacturerPromise = mailToManufacturer(brand, storeEmail, order, orderSK, customerContact, customerId)
    // const mailToStorePromise = mailToStore(brand, storeEmail, ccMail, order, orderSK) 
    // const mailToManuSuccess = await mailToManufacturerPromise
    // const mailToStoreSuccess = await mailToStorePromise

    // console.log("mailToManuSuccess: ", mailToManuSuccess, ", mailToStoreSuccess: ", mailToStoreSuccess)
};