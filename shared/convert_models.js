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
        if (storedModel.dxfPart2ColorMap) model.dxfPart2ColorMap = JSON.parse(storedModel.dxfPart2ColorMap)
    } catch (error) {
        console.log("Failed to convert json because: ", error)
    }
    model.image = "https://images.looc.io/" + storedModel.image
    return model
}

exports.convertStoredMaterial = (stored) => {
    var converted = stored
    let skComponents = stored.sk.split('#')
    converted.type = skComponents[0]
    converted.identifier = skComponents[1]
    delete converted.sk
    try {
        converted.localizedNames = converted.localizedNames ? JSON.parse(converted.localizedNames) : undefined
        converted.parameters = stored.parameters ? JSON.parse(stored.parameters) : {}
    } catch (error) {
        console.log("Failed to convert json because: ", error)
    }
    if (stored.image) converted.image = "https://images.looc.io/" + stored.image
    if (stored.normalTex) converted.normalTex = "https://images.looc.io/" + stored.normalTex

    return converted
}