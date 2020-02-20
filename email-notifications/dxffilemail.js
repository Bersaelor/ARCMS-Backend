/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const SES = new AWS.SES({ region: 'eu-west-1' });
const fs = require("fs");
const strings = require('./locales.js');

// Send email with a number of created dxf files for the ordered frames
exports.newRequest = async (event, context, callback) => {

    const firstRecord = event.Records[0]
    if (!firstRecord || !firstRecord.Sns) {
        throw "Failed to get firstRecord or Sns entry"
    }
    const message = firstRecord.Sns
    const order = JSON.parse(message.Message)
    const brand = message.MessageAttributes.brand.Value
    const orderSK = message.MessageAttributes.orderSK.Value
    if (!order || !brand || !orderSK) {
        throw "Failed to get bodyJSON, brand, orderSK entry"
    }

    console.log("Received order-notification ", orderSK, " for brand ", brand, " need to create DXF models")

    // const mailToManufacturerPromise = mailToManufacturer(brand, storeEmail, order, orderSK, customerContact, customerId)
    // const mailToStorePromise = mailToStore(brand, storeEmail, ccMail, order, orderSK) 
    // const mailToManuSuccess = await mailToManufacturerPromise
    // const mailToStoreSuccess = await mailToStorePromise

    // console.log("mailToManuSuccess: ", mailToManuSuccess, ", mailToStoreSuccess: ", mailToStoreSuccess)
};