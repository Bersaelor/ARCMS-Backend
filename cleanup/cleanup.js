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

function fetchAllModels(brands) {
    let modelFetches = brands.map(brand => {
        return getAllModels(brand).then(data => {
            return data.Items.map(model => {
                return {
                    'image': model.image,
                    'modelFile': model.modelFile,
                    'usdzFile': model.usdzFile
                }
            })
        })
    })
    return Promise.all(modelFetches)
} 

function fetchAllCategories(brands) {
    let categoryFetches = brands.map ( brand => {
        return getCategorys(brand).then(data => {
            return data.Items.map(category => category.image)
        })
    })
    return Promise.all(categoryFetches)
}

// Delete images and models from S3 that are no longer used for any dynamodb entities
exports.cleanOldModelsAndImages = async (event, context, callback) => {
    const brands = Object.keys(brandSettings)

    try {
        console.log("Fetching Models and Categories for: ", brands)
        let modelsPromise = fetchAllModels(brands)
        let categoryPromise = fetchAllCategories(brands)

        let currentImages = new Set()
        let currentModelFiles = new Set()

        let models = await modelsPromise
        models.forEach(array => {
            array.forEach(model => {
                currentImages.add(model.image)
                currentModelFiles.add(model.modelFile)
                currentModelFiles.add(model.usdzFile)
            })
        })

        let categories = await categoryPromise
        categories.forEach(array => {
            array.forEach(image => currentImages.add(image))
        })

        console.log("currentImages ", currentImages)
        console.log("currentModelFiles ", currentModelFiles)

        callback(null, {
            statusCode: 200,
            headers: makeHeader('text/plain'),
            body: JSON.stringify(models)
        });
    
    } catch(err) {
        console.error('Failed cleaning up. Error : ', err);
        const response = {
            statusCode: err.statusCode || 501,
            headers: makeHeader('text/plain'),
            body: 'Failed cleaning up. Error: ' + err,
        };
        callback(null, response);
        return;
    }
};