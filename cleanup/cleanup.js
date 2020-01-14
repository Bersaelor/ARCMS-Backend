/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const { convertStoredModel } = require('../shared/convert_models')
const { getModels } = require('../shared/get_dyndb_models')

// Delete images and models from S3 that are no longer used for any dynamodb entities
exports.cleanOldModelsAndImages = async (event, context, callback) => {
    const brand = event.pathParameters.brand.toLowerCase()
    const category = event.pathParameters.category.toLowerCase()

    const data = await getModels(brand, category)

    const models = data.Items.map((cat) => {
        return convertStoredModel(cat)
    })

    console.log("Returning ", models.length, " models from DynDB")

    callback(null, {
        statusCode: 200,
        headers: makeHeader('text/plain'),
        body: JSON.stringify(models)
    });
};