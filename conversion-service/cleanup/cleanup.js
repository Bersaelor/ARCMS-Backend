/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const s3 = new AWS.S3();
const { getAllModels, getCategorys } = require('../shared/get_dyndb_models')
const brandSettings = require('../../brand_settings.json')

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
            if (data.LastEvaluatedKey) {
                throw `Models for ${brand} exceed fetchLimit for query, please run multiple queries`
            }
            return data.Items.map(model => {
                return {
                    'image': model.image,
                    'modelFile': model.modelFile,
                    'usdzFile': model.usdzFile,
                    'dxfFile': model.dxfFile,
                    'svgFile': model.svgFile
                }
            })
        })
    })
    return Promise.all(modelFetches)
} 

function fetchAllCategories(brands) {
    let categoryFetches = brands.map ( brand => {
        return getCategorys(brand).then(data => {
            if (data.LastEvaluatedKey) {
                throw `Categories for ${brand} exceed fetchLimit for query, please run multiple queries`
            }
            return data.Items.map(category => category.image)
        })
    })
    return Promise.all(categoryFetches)
}

function getS3Content(bucket, continuationToken) {
    var params = {
        Bucket: bucket,
        MaxKeys: 1000,
    }

    if (continuationToken) {
        params.ContinuationToken = continuationToken
    }

    return s3.listObjectsV2(params).promise()
}

function deleteObjects(bucket, keys) {
    var params = {
        Bucket: bucket,
        Delete: {
            Objects: keys.map(key => {
                return { Key: key }
            })
        },
    }

    return s3.deleteObjects(params).promise()
}

// Delete images and models from S3 that are no longer used for any dynamodb entities
exports.cleanOldModelsAndImages = async (event, context, callback) => {
    const brands = Object.keys(brandSettings)

    try {
        console.log("Fetching Models and Categories for: ", brands)
        let modelsPromise = fetchAllModels(brands)
        let categoryPromise = fetchAllCategories(brands)
        let imagesInS3Promise = getS3Content(process.env.IMAGE_BUCKET, null)
        let modelsInS3Promise = getS3Content(process.env.MODEL_BUCKET, null)

        let currentImages = new Set()
        let currentModelFiles = new Set()

        let models = await modelsPromise
        models.forEach(array => {
            array.forEach(model => {
                currentImages.add(model.image)
                currentModelFiles.add(model.modelFile)
                currentModelFiles.add(model.usdzFile)
                currentModelFiles.add(model.dxfFile)
                currentModelFiles.add(model.svgFile)
            })
        })

        let categories = await categoryPromise
        categories.forEach(array => {
            array.forEach(image => currentImages.add(image))
        })

        let imagesInS3Data = await imagesInS3Promise
        if (imagesInS3Data.IsTruncated) { console.log("More images are in S3, but haven't been loaded as maximum was hit") }
        let imageKeys = imagesInS3Data.Contents.map(object => object.Key)
        var imageFileKeysToDelete = []
        imageKeys.forEach(imageKey => {
            if (!currentImages.has(imageKey)) {
                imageFileKeysToDelete.push(imageKey)
            }
        })
        console.log("Deleting images ", imageFileKeysToDelete)
        let deleteImagesPromise = imageFileKeysToDelete.length > 0 ? deleteObjects(process.env.IMAGE_BUCKET, imageFileKeysToDelete) : undefined

        let modelsInS3Data = await modelsInS3Promise
        if (modelsInS3Data.IsTruncated) { console.log("More models are in S3, but haven't been loaded as maximum was hit") }
        let modelKeys = modelsInS3Data.Contents.map(object => object.Key)
        var modelFileKeysToDelete = []
        modelKeys.forEach( modelKey => {
            if (!currentModelFiles.has(modelKey)) {
                modelFileKeysToDelete.push(modelKey)
            }
        })
        console.log("Deleting files ", modelFileKeysToDelete)
        let deleteModelsPromise = modelFileKeysToDelete.length > 0 ? deleteObjects(process.env.MODEL_BUCKET, modelFileKeysToDelete) : undefined

        let deleteImageResult = deleteImagesPromise ? await deleteImagesPromise : "Not needed"
        let deleteModelsResult = deleteModelsPromise ? await deleteModelsPromise : "Not needed"

        console.log("deleteImageResult: ", deleteImageResult)
        console.log("deleteModelsResult: ", deleteModelsResult)

        callback(null, {
            statusCode: 200,
            headers: makeHeader('text/plain'),
            body: JSON.stringify(`Deleted ${deleteImageResult} images and ${deleteModelsResult} models`)
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