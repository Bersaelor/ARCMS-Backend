/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const path = require('path');
const util = require('util');
const s3 = new AWS.S3();
const fs = require("fs");
const xml2js = require('xml2js');
const readline = require('readline');
const { spawn } = require('child_process');
const { tetraGeometry , instanceGeometry } = require('./tetraHedron')

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

async function loadXML(path) {
    return new Promise((resolve, reject) => {
        const parser = new xml2js.Parser(); // {explicitArray : false}
        fs.readFile(path, function(err, data) {
            if (err) { reject(err); return }
            parser.parseString(data, function (err, result) {
                if (err) { reject(err); return }
                resolve(result)
            });
        });
    });
}

async function saveXML(obj, path) {
    return new Promise((resolve, reject) => {
        const builder = new xml2js.Builder();
        const xml = builder.buildObject(obj);
        fs.writeFile(path, xml, function(err) {
            if (err) { reject(err); return }
            else resolve()
        });
    });
}

function fixHelperNodesByAddingGeometry(object) {
    const helperNodeNames = [
        "BRIDGE_TO_LEFT",
        "BRIDGE_TO_RIGHT",
        "LEFT_TO_TEMPLE",
        "RIGHT_TO_TEMPLE",
        "LEFT_TO_PAD",
        "RIGHT_TO_PAD"
    ]

    if (object.$ && object.$.id && helperNodeNames.includes(object.$.id)) {
        if (object.instance_geometry) {
            console.log(`${object.$.id} already has an instance_geometry, no need to add`)
        } else {
            console.log(`Adding instance_geometry to ${object.$.id}`)
            object.instance_geometry = instanceGeometry
        }
    }
}

function traverseNodes(object, transformNode) {
    transformNode(object)

    if (!object.node || !object.node.length || object.node.length === 0) return
    object.node.forEach(child => {
        traverseNodes(child, transformNode)
    });
}

async function fixEmptyNodes(daePath, output) {
    var xmlObj = await loadXML(daePath)
    console.log('Done parsing xml from ', daePath);

    try {
        // add the tetra-mesh to the geometries
        const hasTetraGeometry = xmlObj.COLLADA.library_geometries[0].geometry.find(element => {
            return element.$.id === "tetra-mesh"
        })
        if (hasTetraGeometry) {
            console.log(`Collada file ${daePath} already contains a tetra-mesh, no need to add`)
        } else {
            xmlObj.COLLADA.library_geometries[0].geometry.push(tetraGeometry)
        }

        // add the tetra instance geometry to all empty nodes
        const visualScene = xmlObj.COLLADA.library_visual_scenes[0].visual_scene[0]
        traverseNodes(visualScene, fixHelperNodesByAddingGeometry)
    } catch (error) {
        console.error("Failed to make sense of the parsed COLLADA-XML, problem was: ", error)
    }

    await saveXML(xmlObj, output)
    console.log('Done saving xml to ', output);
}

function convert(downloadPath, uploadPath) {
    return new Promise((resolve, reject) => {
        const isMacOS = process.platform === "darwin";
        const exeName = isMacOS ? 'models/COLLADA2GLTF-macos' : 'COLLADA2GLTF-bin'
        console.log(`Spawning ${exeName} with arguments ${[downloadPath, uploadPath]}`)
        const bash = spawn(exeName, [downloadPath, uploadPath])
        bash.stdout.on('data', data => {
            console.log(`stdout: ${data}`);
        });

        bash.stderr.on('data', data => {
            console.log(`stderr: ${data}`);
            reject(data);
        });

        bash.on('close', code => {
            console.log(`child process exited with code ${code}`);
            if (code === 0) {
                resolve(uploadPath);
            } else {
                reject(`Exit code ${code}`);
            }
        });
    })
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
    if (event.Records) {
        for (const index in event.Records) {
            const record = event.Records[index]
            const bucket = record.s3.bucket.name
            const key = record.s3.object.key
            const parsedPath = path.parse(key)
            const fileName = parsedPath.name
            const extension = parsedPath.ext
            const downloadPath = `/tmp/${fileName}${extension}`
            const fixedDaePath = `/tmp/${fileName}_fixed.dae`
            const uploadPath = `/tmp/${fileName}.gltf`
    
            try {
                console.log(`downloadPath: ${downloadPath}, uploadPath: ${uploadPath}`)
    
                process.env.PATH = `${process.env.PATH}:${process.env.LAMBDA_TASK_ROOT}/models`;
    
                await download(bucket, key, downloadPath)
                await fixEmptyNodes(downloadPath, fixedDaePath)
                await convert(fixedDaePath, uploadPath)
                const uploadRes = await upload(bucket, `${parsedPath.dir}/${fileName}.gltf`, uploadPath)
    
                console.log("Upload result: ", uploadRes)
    
                callback(null, {msg: "Success"})
            } catch(error) {
                console.error(error.code, "-", error.message)
                return callback(error)
            }
        }
    } else if (event.convertUSDZ && event.file) {
        // test the file conversion locally
        const parsedPath = path.parse(event.file)
        const fileName = parsedPath.name
        const uploadPath = `models/tests/${fileName}.gltf`
        const fixedDaePath = `models/tests/${fileName}_fixed.dae`
        await fixEmptyNodes(event.file, fixedDaePath)
        await convert(fixedDaePath, uploadPath)
        console.log("Conversion of ", event.file, " finished")
    }
}