/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const path = require('path');
const s3 = new AWS.S3();
const fs = require("fs");

function download(bucket, key, downloadPath) {
    return new Promise((resolve, reject) => {
        const params = { Bucket: bucket, Key: key }
        const s3Stream = s3.getObject(params).createReadStream();
        const fileStream = fs.createWriteStream(downloadPath);
        s3Stream.on('error', reject);
        fileStream.on('error', reject);
        fileStream.on('close', () => { resolve(downloadPath); });
        s3Stream.pipe(fileStream);
    });
}

function convert(downloadPath, uploadPath) {
    fs.renameSync(downloadPath, uploadPath)
}

function upload(bucket, key, uploadPath) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(uploadPath);

        const params = { Bucket: bucket, Key: key, Body: stream }

        s3.upload(params, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });
}

exports.convert = async (event, context, callback) => {
    for (const index in event.Records) {
        const record = event.Records[index]
        const bucket = record.s3.bucket.name
        const key = record.s3.object.key
        const parsedPath = path.parse(key)
        const fileName = parsedPath.name
        const extension = parsedPath.ext
        const downloadPath = `/tmp/${fileName}${extension}`
        const uploadPath = `/tmp/${fileName}.gltf`

        try {
            console.log(`downloadPath: ${downloadPath}, uploadPath: ${uploadPath}`)

            await download(bucket, key, downloadPath)
            convert(downloadPath, uploadPath)
            const uploadRes = await upload(bucket, `original/${fileName}.gltf`, uploadPath)

            console.log("Upload result: ", uploadRes)

            callback(null, {msg: "Success"})
        } catch(error) {
            console.error(error.code, "-", error.message)
            return callback(error)
        }
    }
}