/*jslint node: true */

'use strict';

const AWS = require('aws-sdk'); 
const Mustache = require('../node_modules/mustache/mustache.min.js');
const fs = require("fs");
const brandSettings = require('../brand_settings.json')
const brandTexts = require('./brand_texts.json')
const dynamoDb = new AWS.DynamoDB.DocumentClient();

async function findUserBrand(cognitoUserName) {
    var params = {
        TableName: process.env.CANDIDATE_TABLE,
        ProjectionExpression: "id, sk",
        KeyConditionExpression: "#id = :value",
        ExpressionAttributeNames:{
            "#id": "id"
        },
        ExpressionAttributeValues: {
            ":value": cognitoUserName
        }
    };

    return new Promise((resolve, reject) => {
        dynamoDb.query(params, (error, data) => {
            if (error) {
                reject(error);
                return;
            } else if (data.Items == undefined || data.Items.length < 1) {
                reject('No user named "' + cognitoUserName + '" found for any brand!');
                return;
            } else {
                const brand = data.Items[0].sk.split('#')[0]
                resolve(brand);
            }
        });
    });
}

// Send email with verification code for password reset
exports.verification = async (event, context, callback) => {

    console.log("Event: ", event);

    if (event.triggerSource !== "CustomMessage_ForgotPassword" && event.triggerSource !== "CustomMessage_AdminCreateUser") {
        callback(null, event);
        return
    }

    const userEmail = event.request.userAttributes.email
    const brand = await findUserBrand(userEmail)

    if (event.triggerSource === "CustomMessage_ForgotPassword") {
        console.log("User: ", userEmail, " needs a verification mail, found brand: ", brand);
    } else if (event.triggerSource === "CustomMessage_AdminCreateUser") {
        console.log("User: ", userEmail, " needs an invitatio mail, found brand: ", brand);
    }

    const contactAddress = brandSettings[brand].orderAdress
    const brandName = brandSettings[brand].name
    const appName = brandSettings[brand].appname || brandSettings[brand].name
    const locale = brandSettings[brand].preferredLanguage
    const isPasswordVerification = event.triggerSource === "CustomMessage_ForgotPassword"
    const fileName = `${isPasswordVerification ? "verification" : "welcome" }_${locale}`
    const htmlTemplate = fs.readFileSync(`./email-notifications/${fileName}.html`, "utf8")
    const downloadLink = brandSettings[brand].appDownloadLink

    const htmlBody = Mustache.render(htmlTemplate, {
        TITLE: brandTexts[brand].title || "",
        APP_NAME: appName,
        BRAND_EMAIL: contactAddress,
        BRAND_IDENTIFIER: brand,
        BRAND_NAME: brandName,
        DOWNLOADLINK: downloadLink,
        LEGAL_FOOTER: brandTexts[brand].legal_footer[locale] || ""
    })

    event.response.emailMessage = htmlBody;

    callback(null, event);
};