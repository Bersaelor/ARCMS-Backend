/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const strings = require('./locales.js');
const brandSettings = require('../brand_settings.json')
import { makeModelParts, combineModel } from './DXFAnalyzer'

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

async function getFile(key) {
    const params = { Bucket: process.env.MODEL_BUCKET, Key: key }
    return s3.getObject().promise()
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
    if (!frames || !brand || !orderSK || !Array.isArray(frames) || frames.length < 1) {
        throw "Failed to get bodyJSON, brand, orderSK entry"
    }

    console.log("Received order-notification ", orderSK, " for brand ", brand, " need to create DXF models")

    const fetchDataPromises = frames.map(async frame => {
        let modelData = await getModel(brand, frame.category, frame.name)
        if (!modelData.Count || modelData.Count < 1 || !modelData.Items[0].dxfFile || !modelData.Items[0].svgFile) return undefined
        const dxfFile = modelData.Items[0].dxfFile
        const svgFile = modelData.Items[0].svgFile
        const dxfPromise = getFile(dxfFile)
        const svgPromise = getFile(svgFile)
        const svgString = await svgPromise
        const dxfString = await dxfPromise
        const modelParts = await makeModelParts(dxfString, svgString)
        // const model = combineModel(modelParts, bridgeSize, glasWidth, glasHeight, defaultSizes)
        // const renderOptions = { usePOLYLINE: true }
        // const dxf = makerjs.exporter.toDXF(model, renderOptions)
        console.log(`For ${frame.name} we found model parts: `, modelParts)
    })

    const fetchDataSuccess = await Promise.all(fetchDataPromises)

    console.log("fetchDataSuccess: ", fetchDataSuccess)
};