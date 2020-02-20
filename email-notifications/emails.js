/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const SES = new AWS.SES({ region: 'eu-west-1' });
const fs = require("fs");
const Mustache = require('../node_modules/mustache/mustache.min.js');
const strings = require('./locales.js');

const manufacturerAdresses = {
    "grafix": "order@grafix-eyewear.com",
    "domvetro": "konrad@looc.io"
}

const manufacturerLanguages = {
    "grafix": "de",
    "domvetro": "en"
}

const manufacturerNames = {
    "grafix": "Grafix",
    "domvetro": "DOM VETRO"
}

const appDownloadLink = {
    "grafix": "https://apps.apple.com/us/app/grafix-ar/id1450301394?ls=1",
    "domvetro": "https://beta.itunes.apple.com/v1/app/1350106957"
}

function localizeOrder(order, locale) {
    return order.map(frame => {
        frame.frameOrderDetailItems = frame.frameOrderDetailItems.map(item => {
            if (item.titleTerm) {
                item.title = strings[locale][item.titleTerm]
            }
            if (item.defaultSize && item.chosenSize) {
                let localeTemplate = item.defaultSize == item.chosenSize ? strings[locale].detail_item_default_size : strings[locale].detail_item_special_size
                item.valueTitle = Mustache.render(localeTemplate, { SIZE: `${item.chosenSize} mm` })
            } else {
                item.valueTitle = item.chosenDetails
            }
            return item
        })
        return frame
    })
}

function doesOrderContainSpecialSize(order) {
    return order.find(frame => frame.isBespokeSize === true) != undefined
}

async function mailToStore(brand, storeEmail, ccMail, order, orderSK) {
    if(!manufacturerAdresses[brand]) {
        throw `There is no manufacturer address saved for brand ${brand}`
    }

    const locale = manufacturerLanguages[brand]
    const localizedOrder = localizeOrder(order, locale)
    const brandName = manufacturerNames[brand]
    const subject = Mustache.render(strings[locale].subject_store, { BRAND_NAME: brandName })
    const htmlTemplate = fs.readFileSync(`./email-notifications/store_${locale}.html`, "utf8")
    const link = `https://cms.looc.io/${brand}/orders/${encodeURIComponent(orderSK)}`
    const downloadLink = appDownloadLink[brand]

    const htmlBody = Mustache.render(htmlTemplate, {
        ORDERS: localizedOrder, 
        LINK: link, 
        BRAND_EMAIL: manufacturerAdresses[brand],
        BRAND_NAME: brandName,
        ISTESTENVIRONMENT: process.env.STAGE != "prod",
        SPECIALSIZEDISCLAIMER: doesOrderContainSpecialSize(order),
        DOWNLOADLINK: downloadLink,
    })

    let ccs = ccMail && ccMail.replace(/\s/g,'').split(";")

    return sendMail(manufacturerAdresses[brand], storeEmail, ccs, subject, htmlBody)
}

async function mailToManufacturer(brand, storeEmail, order, orderSK, customerContact, customerId) {
    if(!manufacturerAdresses[brand]) {
        throw `There is no manufacturer address saved for brand ${brand}`
    }

    const locale = manufacturerLanguages[brand]
    const localizedOrder = localizeOrder(order, locale)
    const subject = Mustache.render(strings[locale].subject_manu, {STORE: storeEmail, FRAME_COUNT: order.length})
    const htmlTemplate = fs.readFileSync(`./email-notifications/manufacturer_${locale}.html`, "utf8")
    const link = `https://cms.looc.io/${brand}/orders/${encodeURIComponent(orderSK)}`
    const downloadLink = appDownloadLink[brand]
    const htmlBody = Mustache.render(htmlTemplate, {
        STORE: storeEmail, 
        CONTACT: customerContact,
        CUSTOMERID: customerId,
        ORDERS: localizedOrder,
        LINK: link,
        ISTESTENVIRONMENT: process.env.STAGE != "prod",
        DOWNLOADLINK: downloadLink,
    })
    const sender = "no_reply@looc.io"

    let manufacturerMail = storeEmail === "konrad@looc.io" ? "konrad@looc.io" : manufacturerAdresses[brand]
    return sendMail(sender, manufacturerMail, [], subject, htmlBody)
}

function validateEmail(email) {
    var re = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return re.test(email);
}

async function sendMail(sender, to, cc, subject, htmlBody) {
    const fromBase64 = Buffer.from(sender).toString('base64');

    var sesParams = {
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

    let ccMails = cc && cc.filter(e => validateEmail(e))
    if (ccMails && ccMails.length > 0) {
        sesParams.Destination.CcAddresses = ccMails
        console.log("Sending cc's to ", ccMails)
    }

    return SES.sendEmail(sesParams).promise();
}

// Send email notifications when new order is received
exports.newOrder = async (event, context, callback) => {

    const firstRecord = event.Records[0]
    if (!firstRecord || !firstRecord.Sns) {
        throw "Failed to get firstRecord or Sns entry"
    }
    const message = firstRecord.Sns
    const order = JSON.parse(message.Message)
    const storeEmail = message.MessageAttributes.storeEmail.Value
    const ccMail = message.MessageAttributes.ccMail && message.MessageAttributes.ccMail.Value
    const brand = message.MessageAttributes.brand.Value
    const orderSK = message.MessageAttributes.orderSK.Value
    const customerContact = message.MessageAttributes.contactName.Value
    const customerId = message.MessageAttributes.customerId.Value
    if (!order || !storeEmail || !brand || !orderSK) {
        throw "Failed to get bodyJSON, storeEmail, brand, orderSK entry"
    }

    console.log("Received order-notification from ", storeEmail, " for brand ", brand)

    const mailToManufacturerPromise = mailToManufacturer(brand, storeEmail, order, orderSK, customerContact, customerId)
    const mailToStorePromise = mailToStore(brand, storeEmail, ccMail, order, orderSK) 
    const mailToManuSuccess = await mailToManufacturerPromise
    const mailToStoreSuccess = await mailToStorePromise

    console.log("mailToManuSuccess: ", mailToManuSuccess, ", mailToStoreSuccess: ", mailToStoreSuccess)
};