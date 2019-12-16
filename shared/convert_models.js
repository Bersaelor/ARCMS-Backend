/*jslint node: true */

'use strict';

exports.convertStoredModel = (storedModel) => {
    var model = storedModel
    model.category = storedModel.sk.split('#')[0]
    model.name = storedModel.sk.split('#')[1]
    delete model.sk
    try {
        model.localizedNames = storedModel.localizedNames ? JSON.parse(storedModel.localizedNames) : undefined
        model.props = storedModel.props ? JSON.parse(storedModel.props) : undefined    
    } catch (error) {
        console.log("Failed to convert json because: ", error)
    }
    model.image = "https://images.looc.io/" + storedModel.image
    return model
}