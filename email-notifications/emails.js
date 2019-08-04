/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const SES = new AWS.SES({ region: 'eu-west-1' });

const manufacturerAddresses = {
    "grafix": "mom@looc.io",
    "domevtro": "konrad@looc.io"
}

const manufacturerLanguages = {
    "grafix": "de",
    "domevtro": "en"
}

const subjectLines = {
    "de": "Neue Bestellung von $FRAME_COUNT$ Brillen für $STORE$",
    "en": "New order for $FRAME_COUNT$ frames from $STORE$"
}

function makeHeader(content) {
    return { 
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': true,
        'Content-Type': content
    };
}

const from = "no_reply@looc.io"

async function mailToManufacturer(brand, storeEmail, orders) {
    if(!manufacturerAddresses[brand]) {
        throw `There is no manufacturer address saved for brand ${brand}`
    }

    const locale = manufacturerLanguages[brand]

    const fromBase64 = Buffer.from(from).toString('base64');

    const subject = subjectLines[locale].replace("$STORE$", storeEmail).replace("$FRAME_COUNT$", `${orders.length}`)

    const htmlBody = `
    <!DOCTYPE html>
    <html>
      <head></head>
      <body><h1>Hello world!</h1></body>
    </html>
  `;

    const sesParams = {
        Destination: {
            ToAddresses: [manufacturerAddresses[brand]],
        },
        Message: {
            Body: {
                Html: {
                    Charset: 'UTF-8',
                    Data: htmlBody,
                },
            },
            Subject: {
                Charset: 'UTF-8',
                Data: subject,
            },
        },
        Source: `=?utf-8?B?${fromBase64}?= <${from}>`,
    };

    return SES.sendEmail(sesParams).promise();
}

// Delete a device from the current user
exports.newOrder = async (event, context, callback) => {
    const firstRecord = event.Records[0]
    if (!firstRecord || !firstRecord.Sns) {
        throw "Failed to get firstRecord or Sns entry"
    }
    const message = firstRecord.Sns
    let order = JSON.parse(message.Message)
    let storeEmail = message.MessageAttributes.storeEmail.Value
    let brand = message.MessageAttributes.brand.Value
    if (!order || !storeEmail || !brand) {
        throw "Failed to get bodyJSON, storeEmail, brand entry"
    }

    console.log("Received order-notification from ", storeEmail, " for brand ", brand)

    console.log("order: ", order)

    const mailToManufacturerPromise = mailToManufacturer(brand, storeEmail, order) 

    const mailToManuSuccess = await mailToManufacturerPromise

    console.log("mailToManuSuccess: ", mailToManuSuccess)
};