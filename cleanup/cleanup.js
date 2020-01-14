/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const { convertStoredModel } = require('../shared/convert_models')
const { getAllModels, getCategorys } = require('../shared/get_dyndb_models')
const brandSettings = require('../brand_settings.json')

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

// Delete images and models from S3 that are no longer used for any dynamodb entities
exports.cleanOldModelsAndImages = async (event, context, callback) => {
    const brands = Object.keys(brandSettings)

    try {
        
        console.log("Fetching Models and Categories for: ", brands)
        let modelFetches = brands.map ( brand => getAllModels(brand))
        let modelsPromise = Promise.all(modelFetches)

        let categoryFetches = brands.map ( brand => getCategorys(brand))
        let categoryPromise = Promise.all(categoryFetches)

        let models = await modelsPromise
        let categories = await categoryPromise
        console.log("models ", models)
        console.log("categories ", categories)
        
        callback(null, {
            statusCode: 200,
            headers: makeHeader('text/plain'),
            body: JSON.stringify(models)
        });
    
    } catch(err) {
        console.error('Failed cleaning up. Error JSON: ', JSON.stringify(err, null, 2));
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Failed cleaning up. Error: ' + err,
        };
        callback(null, response);
        return;
    }
};