/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const SES = new AWS.SES({ region: 'eu-west-1' });
const fs = require("fs");
const Mustache = require('../node_modules/mustache/mustache.min.js');
const strings = require('./locales.js');

const manufacturerAdresses = {
    "grafix": "mom@looc.io",
    "domevtro": "konrad@looc.io"
}

const manufacturerLanguages = {
    "grafix": "de",
    "domvetro": "en"
}

const manufacturerNames = {
    "grafix": "Grafix",
    "domvetro": "DOM VETRO"
}

function localizeOrder(order, locale) {
    return order.map(frame => {
        frame.frameOrderDetailItems = frame.frameOrderDetailItems.map(item => {
            if (item.titleTerm) {
                item.title = strings[locale][item.titleTerm]
            }
            return item
        })
        return frame
    })
}

async function mailToStore(brand, storeEmail, order, orderSK) {
    if(!manufacturerAdresses[brand]) {
        throw `There is no manufacturer address saved for brand ${brand}`
    }

    const locale = manufacturerLanguages[brand]
    const localizedOrder = localizeOrder(order, locale)
    const brandName = manufacturerNames[brand]
    const subject = Mustache.render(strings[locale].subject_store, { BRAND_NAME: brandName })
    const htmlTemplate = fs.readFileSync(`./email-notifications/store_${locale}.html`, "utf8")
    const link = `https://cms.looc.io/${brand}/orders/${encodeURIComponent(orderSK)}`
    const htmlBody = Mustache.render(htmlTemplate, {
        ORDERS: localizedOrder, 
        LINK: link, 
        BRAND_EMAIL: manufacturerAdresses[brand],
        BRAND_NAME: brandName
    })

    return sendMail(manufacturerAdresses[brand], storeEmail, subject, htmlBody)
}

async function mailToManufacturer(brand, storeEmail, order, orderSK) {
    if(!manufacturerAdresses[brand]) {
        throw `There is no manufacturer address saved for brand ${brand}`
    }

    const locale = manufacturerLanguages[brand]
    const localizedOrder = localizeOrder(order, locale)
    const subject = Mustache.render(strings[locale].subject_manu, {STORE: storeEmail, FRAME_COUNT: order.length})
    const htmlTemplate = fs.readFileSync(`./email-notifications/manufacturer_${locale}.html`, "utf8")
    const link = `https://cms.looc.io/${brand}/orders/${encodeURIComponent(orderSK)}`
    const htmlBody = Mustache.render(htmlTemplate, {
        STORE: storeEmail, 
        ORDERS: localizedOrder,
        LINK: link
    })
    const sender = "no_reply@looc.io"
    return sendMail(sender, manufacturerAdresses[brand], subject, htmlBody)
}

async function sendMail(sender, to, subject, htmlBody) {
    const fromBase64 = Buffer.from(sender).toString('base64');

    const sesParams = {
        Destination: {
            ToAddresses: [to],
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
        Source: `=?utf-8?B?${fromBase64}?= <${sender}>`,
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
    const order = JSON.parse(message.Message)
    const storeEmail = message.MessageAttributes.storeEmail.Value
    const brand = message.MessageAttributes.brand.Value
    const orderSK = message.MessageAttributes.orderSK.Value
    if (!order || !storeEmail || !brand || !orderSK) {
        throw "Failed to get bodyJSON, storeEmail, brand, orderSK entry"
    }

    console.log("Received order-notification from ", storeEmail, " for brand ", brand)

    const mailToManufacturerPromise = mailToManufacturer(brand, storeEmail, order, orderSK) 
    const mailToStorePromise = mailToStore(brand, storeEmail, order, orderSK) 
    const mailToManuSuccess = await mailToManufacturerPromise
    const mailToStoreSuccess = await mailToStorePromise

    console.log("mailToManuSuccess: ", mailToManuSuccess, ", mailToStoreSuccess: ", mailToStoreSuccess)
};