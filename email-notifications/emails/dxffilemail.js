/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const SES = new AWS.SES({ region: 'eu-west-1' });
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
var nodemailer = require("nodemailer");
const strings = require('./locales.js');
const brandSettings = require('../brand_settings.json')
const makerjs = require('makerjs');
const { makeModelParts, combineModel } = require('./DXFCombiner.js');


async function getModel(brand, category, modelName) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "sk, dxfFile, dxfPart2ColorMap, svgFile, props",
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
    return s3.getObject(params).promise()
}

async function sendMail(sender, to, subject, htmlBody, files) {
    const transporter = nodemailer.createTransport({ SES: SES });

    const mailOptions = {
        from: sender,
        subject: subject,
        html: htmlBody,
        to: to,
        cc: 'konrad@looc.io',
        attachments: files
    }

    return new Promise(function (resolve, reject) {
        transporter.sendMail(mailOptions, function (err, info) {
            if (err) reject(err)
            else {
                console.log("Successfully sent email: ", info)
                resolve()
            }
        });
    })
}

async function mailToManufacturer(brand, orderSK, files, errors) {
    let brandMail = brandSettings[brand].orderAdress
    if(!brandMail) {
        throw `There is no manufacturer address saved for brand ${brand}`
    }

    const locale = brandSettings[brand].preferredLanguage
    const link = `https://cms.looc.io/${brand}/orders/${encodeURIComponent(orderSK)}`
    const customer = orderSK.split('#')[0]
    const dateISOString = orderSK.split('#')[1]
    const orderDate = new Date(dateISOString)
    const localizedDate = orderDate.toLocaleString(locale, { timeZone: brandSettings[brand].timeZone })
    console.log("customer: ", customer, ", date: ", orderDate.toString())

    var errorText = undefined
    if (errors.length > 0) {
        errorText = `<p>Problems found:</p>
            <ul>
                ${ errors.map(s => "<li>" + s + "</li>").join() }
            </ul>
        `
    }

    var htmlBody, subject 
    if (locale.startsWith('de')) {
        subject = `Angepasste CAD Dateien für Bestellung von ${customer} vom ${localizedDate}`
        htmlBody = `
    <html>
        <body lang="DE" link="#0563C1" vlink="#954F72">
        <br>
        <p>Hallo!</p>
        <p>Der looc.io Roboter freut sich Ihnen die angehängten Modelle für die Bestellung von ${customer} um ${localizedDate} senden zu können:</p>
        <p>Mehr Details zur Bestellung können auf <a href="${link}">cms.looc.io eingesehen werden</a>.
        <BR><BR>
        <p>Mit freundlichen Grüßen</p>
        <p>🤖</p>
        ${ errorText || "" }
        </body>
    </html>
    `    
    }
    const sender = "no_reply@looc.io"

    let manufacturerMail = customer === "konrad@looc.io" ? "konrad@looc.io" : brandMail
    return sendMail(sender, manufacturerMail, subject, htmlBody, files)
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

    console.log("Received dxf creation request ", orderSK, " for brand ", brand, " need to create DXF models")

    const fetchDataPromises = frames.map(async frame => {
        var start = new Date()

        let modelData = await getModel(brand, frame.category, frame.name)
        if (!modelData.Count || modelData.Count < 1 || !modelData.Items[0].props || !modelData.Items[0].svgFile) {
            let msg = `Can't convert dxf for '${frame.name}' as no dxf reference file was uploaded yet`
            return msg
        }
        const props = JSON.parse(modelData.Items[0].props)
        const dxfPart2ColorMap = modelData.Items[0].dxfPart2ColorMap
        if (!dxfPart2ColorMap || !props.defaultBridgeSize || !props.defaultGlasWidth || !props.defaultGlasHeight) {
            let msg = `Failed to get necessary modelData from model '${frame.name}': ${modelData}`
            console.error(msg)
            return msg
        }

        const part2ColorMap = JSON.parse(dxfPart2ColorMap)
        const necessaryParts = ['bridge', 'shape', 'pad']
        const missingparts = necessaryParts.filter(name => part2ColorMap[name] === undefined)
        if (missingparts.length > 0) {
            let msg = `The color map of the model '${frame.name}' doesn't contain ${missingparts.join(', ')} which is required`
            console.error(msg)
            return msg
        }

        try {
            const svgFile = modelData.Items[0].svgFile
            const svgPromise = getFile(svgFile)
            const svgString = (await svgPromise).Body.toString('utf-8')
            const modelParts = await makeModelParts(part2ColorMap, svgString)

            const { model } = combineModel(
                modelParts, frame.bridgeWidth, frame.glasWidth, frame.glasHeight, 
                { bridgeSize: props.defaultBridgeSize, glasWidth: props.defaultGlasWidth, glasHeight: props.defaultGlasHeight },
                false,
                undefined
            )
            const renderOptions = { usePOLYLINE: true }
            const dxf = makerjs.exporter.toDXF(model, renderOptions)
            const fileName = `${frame.name}-${frame.glasWidth}-${frame.bridgeWidth}-${frame.glasHeight}.dxf`
            var duration = new Date() - start
            console.log(`Created dxf of length ${dxf.length} for ${frame.name} in %dms`, duration)
            return { filename: fileName, content: dxf }    
        } catch (error) {
            let msg = `Failed to convert model '${frame.name}' because of ${error }`
            console.error(msg)
            return msg
        }
    })

    const output = await Promise.all(fetchDataPromises)
    const outPutDXFFiles = output.filter(value => (value !== undefined && value.filename))
    const errors = output.filter(value => (value !== undefined && typeof value === 'string'))
    if (outPutDXFFiles.length < 1 && errors < 1) {
        console.log("No models were converted, not sending email")
        return
    }
    const emailResult = await mailToManufacturer(brand, orderSK, outPutDXFFiles, errors)
    console.log("emailResult: ", emailResult)
};