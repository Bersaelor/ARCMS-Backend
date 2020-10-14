/*jslint node: true */

'use strict';

const aws = require('aws-sdk'); 
aws.config.update({region: process.env.AWS_REGION})
const AthenaExpress = require("athena-express");
const brandSettings = require('brand_settings.json')

const apic_log_table = 'apic_cloudfront_logs'
const ATHENA_OUTPUT_LOCATION = 's3://looc-ar-api-statistics/query-results/'

const athenaExpressConfig = {
	aws, /* required */
    db: 'default',
	s3: ATHENA_OUTPUT_LOCATION, /* optional */
	formatJson: true, /* optional default=true */
	retry: 200, /* optional default=200 */
    getStats: false /* optional default=false */
};
const athenaExpress = new AthenaExpress(athenaExpressConfig);
const dynamoDb = new aws.DynamoDB.DocumentClient();

const RESULT_SIZE = 1000

const dateToSQL = (date) => {
    return date.toISOString().split('T')[0]
}

const iOSVersions = {
    "18.0.0": "12.0",
    "18.2.0": "12.1",
    "18.7.0": "12.4",
    "19.0.0": "13.0",
    "19.2.0": "13.3",
    "19.3.0": "13.3.1",
    "19.4.0": "13.4",
    "19.5.0": "13.5",
    "19.6.0": "13.6",
    "20.0.0": "14.0",
    "20.1.0": "14.2"
}

const getBrandAppDataHits = async (brand, from, to, appAgentName) => {
    let query = {
        sql: `\
        SELECT user_agent\
        FROM ${apic_log_table} \
        WHERE \
        (\
        "date" BETWEEN DATE '${dateToSQL(from)}' AND DATE '${dateToSQL(to)}' AND\
        "uri" LIKE '%${brand}/app-data%' AND\
        "user_agent" LIKE '${appAgentName}%' AND\
        "query_string" = '-'\
        )\
        LIMIT ${RESULT_SIZE};\
        `
    }

    return athenaExpress.query(query)
}

const analyzeAgentArray = (userAgents) => {
    var appVersions = {}
    var osVersions = {}

    userAgents.forEach(element => {
        let parts = element.split('%20')
        if (parts && parts.length > 2) {
            let appAndVersion = parts[0].split('/')
            if (appAndVersion.length > 1) {
                let appVersion = appAndVersion[1]
                appVersions[appVersion] = appVersions[appVersion] === undefined ? 1 : appVersions[appVersion] + 1
            }
            var osVersion = 'unknown'
            let darwinAndVersion = parts[2].split('/')
            if (darwinAndVersion.length > 1 && darwinAndVersion[0] === "Darwin" && iOSVersions[darwinAndVersion[1]]) {
                osVersion = `iOS ${iOSVersions[darwinAndVersion[1]]}`
            }
            osVersions[osVersion] = osVersions[osVersion] === undefined ? 1 : osVersions[osVersion] + 1
        }
    });

    return {
        appVersions: appVersions,
        osVersions: osVersions,
        total: userAgents.length
    }
}

// Queries the cloudfront logs for the appData
exports.appData = async (event, context, callback) => {
    var day = new Date(event.time) 
    day.setHours(1, 0, 0, 0)

    var dayBefore = new Date(day.getTime())
    dayBefore.setDate(day.getDate() - 1)

    try {
        const brands = Object.keys(brandSettings)

        let promises = brands
            .filter( brand => brandSettings[brand].AppAgentName !== undefined )
            .map( brand => {
                return getBrandAppDataHits(brand, dayBefore, day, brandSettings[brand].AppAgentName)
                    .then( data => {
                        const userAgents = data.Items.map(item => item.user_agent )
                        const analysis = analyzeAgentArray(userAgents)
                        console.log("analysis: ", analysis)
                        return analysis
                    })
            })

		let results = await Promise.all(promises)
		console.log(results);
	} catch (error) {
		console.log(error);
	}
}