/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const SES = new AWS.SES({ region: 'eu-west-1' });
const fs = require("fs");
const Mustache = require('../node_modules/mustache/mustache.min.js');
const strings = require('./locales.js');

const manufacturerAddresses = {
    "grafix": "mom@looc.io",
    "domevtro": "konrad@looc.io"
}

const manufacturerLanguages = {
    "grafix": "de",
    "domevtro": "en"
}

const from = "no_reply@looc.io"

async function mailToManufacturer(brand, storeEmail, order, orderSK) {
    if(!manufacturerAddresses[brand]) {
        throw `There is no manufacturer address saved for brand ${brand}`
    }

    const locale = manufacturerLanguages[brand]
    const localizedOrder = order.map(frame => {
        frame.frameOrderDetailItems = frame.frameOrderDetailItems.map(item => {
            if (item.titleTerm) {
                item.title = strings[locale][item.titleTerm]
            }
            return item
        })
        return frame
    })
    const fromBase64 = Buffer.from(from).toString('base64');
    const subject = Mustache.render(strings[locale].subject, {STORE: storeEmail, FRAME_COUNT: order.length})
    const htmlTemplate = fs.readFileSync(`./email-notifications/manufacturer_${locale}.html`, "utf8")
    const link = `https://cms.looc.io/${brand}/orders/${encodeURIComponent(orderSK)}`
    const htmlBody = Mustache.render(htmlTemplate, {STORE: storeEmail, ORDERS: localizedOrder, LINK: link})

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
    let orderSK = message.MessageAttributes.orderSK.Value
    if (!order || !storeEmail || !brand || !orderSK) {
        throw "Failed to get bodyJSON, storeEmail, brand, orderSK entry"
    }

    console.log("Received order-notification from ", storeEmail, " for brand ", brand)

    const mailToManufacturerPromise = mailToManufacturer(brand, storeEmail, order, orderSK) 
    const mailToManuSuccess = await mailToManufacturerPromise

    console.log("mailToManuSuccess: ", mailToManuSuccess)
};