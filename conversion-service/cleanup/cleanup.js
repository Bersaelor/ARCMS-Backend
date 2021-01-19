/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const path = require('path');

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
            if (data.LastEvaluatedKey) {
                throw `Models for ${brand} exceed fetchLimit for query, please run multiple queries`
            }
            return data.Items.map(model => {
                return {
                    'image': model.image,
                    'modelFile': model.modelFile,
                    'usdzFile': model.usdzFile,
                    'gltfFile': model.gltfFile,
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

function fetchAppHeaderImages() {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, headerImage",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":value": "appconfig",
        },
    };

    return dynamoDb.query(params).promise().then( data => {
        return data.Items.map( (item) => item.headerImage )
    });
}

const fetchMaterials = async (brand) => {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, image, normalTex",
        KeyConditionExpression: "#id = :id",
        ExpressionAttributeNames: {
            "#id": "id",
        },
        ExpressionAttributeValues: {
            ":id": `material#${brand}`
        }
    };

    return dynamoDb.query(params).promise()
}

const fetchAllMaterials = async (brands) => {
    let materialFetches = brands.map(brand => {
        return fetchMaterials(brand).then(data => {
            if (data.LastEvaluatedKey) {
                throw `Categories for ${brand} exceed fetchLimit for query, please run multiple queries`
            }
            return data.Items
        })
    })
    const itemArrays = await Promise.all(materialFetches)
    return itemArrays.reduce((acc, x) => acc.concat(x), [])
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

async function getAllS3Content(bucket) {
    var continuationToken
    var keys = []
    do {
        const data = await getS3Content(bucket, continuationToken)
        continuationToken = data.NextContinuationToken
        keys = keys.concat(data.Contents.map(object => object.Key))
    } while (continuationToken !== undefined)
    return keys
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
        const data = await Promise.all([
            fetchAllModels(brands),
            fetchAllMaterials(brands),
            fetchAllCategories(brands),
            fetchAppHeaderImages(),
            getAllS3Content(process.env.IMAGE_BUCKET),
            getAllS3Content(process.env.MODEL_BUCKET),
        ])
        let models = data[0]
        let materials = data[1]
        let categories = data[2]
        let headerImages = data[3]
        let imageKeys = data[4]
        let modelKeys = data[5]

        let currentImages = new Set()
        let currentModelFiles = new Set()

        models.forEach(array => {
            array.forEach(model => {
                currentImages.add(model.image)
                currentModelFiles.add(model.modelFile)
                currentModelFiles.add(model.usdzFile)
                currentModelFiles.add(model.gltfFile)
                currentModelFiles.add(model.dxfFile)
                currentModelFiles.add(model.svgFile)
                if (model.modelFile) {
                    // replace the first folder name `original` with `metafiles`
                    const metaFolderPath = model.modelFile.replace('original', 'metafiles')
                    // the last `-` is the one between filename and timestamp, like `hornbrillefinal-1583230935604.dae`
                    const dashSeparated = metaFolderPath.split('-')
                    dashSeparated.pop()
                    const pathWithoutTimeStamp = dashSeparated.join()
                    // add a blank metafile entry for all the associated metafiles
                    currentModelFiles.add(pathWithoutTimeStamp)
                }
            })
        })

        let specialImageKeys = ["placeholder.png"]
        specialImageKeys.forEach(key => {
            currentImages.add(key)
        })

        materials.forEach(material => {
            if (material.image) currentImages.add(material.image)
            if (material.normalTex) currentImages.add(material.normalTex)
        })

        categories.forEach(array => {
            array.forEach(image => currentImages.add(image))
        })

        headerImages.forEach(key => currentImages.add(key))

        var imageFileKeysToDelete = []
        imageKeys.forEach(imageKey => {
            if (!currentImages.has(imageKey)) {
                imageFileKeysToDelete.push(imageKey)
            }
        })
        console.log("Deleting images ", imageFileKeysToDelete)
        let deleteImagesPromise = imageFileKeysToDelete.length > 0 ? deleteObjects(process.env.IMAGE_BUCKET, imageFileKeysToDelete) : undefined

        var modelFileKeysToDelete = []
        modelKeys.forEach( modelKey => {
            if (modelKey.startsWith("metafiles")) {
                if (!currentModelFiles.has(path.dirname(modelKey))) {
                    modelFileKeysToDelete.push(modelKey)
                }
            } else if (!currentModelFiles.has(modelKey)) {                
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