import makerjs, { IModelMap, IPathMap } from 'makerjs';
import xml2js from 'xml2js';

const tol = 0.0001
const minPadX = 0.2

const partNames: {[part: string]: string[]} = {
    bridge: ["bridge", "bruecke", "brücke"],
    shape: ["shape", "front", "frame", "shape_left", "shape_right"],
    hinge: ["hinge", "hinge_left", "hinge_right", "backe"],
    pad: ["pad", "pad_left", "pad_right"]
}

interface SVGPath {
    $: {
        style: string,
        d: string
    }
}

interface SVGCircle {
    $: {
        cx: string,
        cy: string,
        r: string,
        style: string,
    }
}

interface SVGGroup {
    path: SVGPath[]
    circle?: SVGCircle[]
}

interface SVG {
    svg: {
        g: SVGGroup[]
    }
}

interface SizeParameters {
    bridgeSize: number
    glasWidth: number
    glasHeight: number
    templeLength: number
}

function modelFromPaths(paths: string[]): makerjs.IModel {
    let makerobjects = paths.map(pathData => {
        const pathModel = makerjs.importer.fromSVGPathData(pathData)
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        const mirroredModel = makerjs.model.mirror(pathModel, false, true)

        makerjs.model.originate(mirroredModel)
        makerjs.model.simplify(mirroredModel)
        return mirroredModel
    })
    let obj = makerobjects.reduce<IModelMap>((acc, cur, i) => {
        acc[i] = cur;
        return acc;
    }, {});
    let model = { models: obj }

    return model
}

function modelFromCircles(circles: SVGCircle[]): makerjs.IModel {
    let circlePaths = circles.map(circle => {
        let radius = parseFloat(circle.$.r)
        // when the dxf is converted to the original svg it's y is inverted, undo this here
        let center = [parseFloat(circle.$.cx), parseFloat(circle.$.cy)]
        return new makerjs.paths.Circle(center, radius)
    })
    let pathMap = circlePaths.reduce<IPathMap>((acc, cur, i) => {
        acc[i] = cur;
        return acc;
    }, {});

    return { paths: pathMap }
}

function createParts(
    part2ColorMap: { [part: string]: string },
    svgObj: SVG | undefined,
): makerjs.IModelMap {
    if (!svgObj || !svgObj.svg || svgObj.svg.g.length < 1 || !svgObj.svg.g[0].path) {
        console.log("SvgObj is missing key svg properties!")
        return {}
    }

    var parts: { [part: string]: makerjs.IModel } = {}
    Object.keys(partNames).forEach(part => {
        let color = part2ColorMap[part]
        if (color) {
            let firstGroup = svgObj.svg.g[0]
            let paths = firstGroup.path
            let matchingPaths = paths.filter(path => path.$ && path.$.style.startsWith && path.$.style.startsWith(`stroke:${color}`))
            if (matchingPaths.length > 0) {
                parts[part] = modelFromPaths(matchingPaths.map(path => path.$.d))
            }
            if (firstGroup.circle && firstGroup.circle.length > 0) {
                let colorFittingCircles = firstGroup.circle.filter(c => c.$.style.startsWith(`stroke:${color}`))
                if (part === "shape") {
                    parts[`${part}_holes`] = modelFromCircles(colorFittingCircles)
                } else {
                    console.log(`Unhandled circles for ${part}: `, firstGroup.circle)
                }
            }
        }
    })

    return parts
}

type Warning = {
    term: string
    data: {[key: string]: string}
}

export async function makeModelParts(
    part2ColorMap: { [part: string]: string },
    svgContents: string
): Promise<makerjs.IModelMap> {
    const parser = new xml2js.Parser();
    const svgObj = await parser.parseStringPromise(svgContents)
    const parts = createParts(part2ColorMap, svgObj)

    const options: makerjs.IFindChainsOptions = {
        pointMatchingDistance: 0.05,
        shallow: false,
        unifyBeziers: true
    }

    var convertedParts: { [part: string]: makerjs.IModel } = {}
    Object.keys(parts).forEach(key => {
        const part = parts[key]
        const chains = makerjs.model.findChains(part, options) as makerjs.IChain[]
        if (chains.length === 1) {
            let model = makerjs.chain.toNewModel(chains[0], true)
            convertedParts[key] = model
        } else if (chains.length > 1) {
            var modelMap: { [part: string]: makerjs.IModel } = {}
            chains.forEach((element, index) => {
                modelMap[`${key}-${index}`] = makerjs.chain.toNewModel(element, true)
            })
            convertedParts[key] = { models: modelMap }
        }
    })

    let bridgeMeas = makerjs.measure.modelExtents(convertedParts.bridge)
    let shapeMeas = makerjs.measure.modelExtents(convertedParts.shape)
    let isLeftSide = shapeMeas.center[0] < bridgeMeas.center[0]
    
    // move combined model to have origin [0, 0]
    let fullMeas = makerjs.measure.modelExtents({ models: convertedParts })
    let combined = { models: convertedParts, origin: makerjs.point.scale(fullMeas.low, -1) }
    makerjs.model.originate(combined)
    makerjs.model.zero(combined)

    if (isLeftSide) {
        // mirror the parts so the bridge is the part that starts at 0
        Object.keys(combined.models).forEach(key => {
            const model = combined.models[key]
            combined.models[key] = makerjs.model.distort(model, -1, 1)
        })
        makerjs.model.zero(combined)
        makerjs.model.originate(combined)    
    } 

    // move down so the vertical center line is 0
    let newBridgeMeas = makerjs.measure.modelExtents(combined.models.bridge)
    makerjs.model.moveRelative(combined, [0, -newBridgeMeas.center[1]])
    makerjs.model.originate(combined)    

    return combined.models
}

type LineInfo = {
    line: makerjs.IPathLine,
    route: string[]
    isAtOrigin?: boolean
}

function findConnectingLine(shape: makerjs.IModel, pad: makerjs.IModel) {
    var warnings: Warning[] = []

    // find the connection line in the shape
    let padMax = makerjs.measure.modelExtents(pad).high[0]
    var linesConnectedToPadMax: LineInfo[] = []
    var findInShapeWalk: makerjs.IWalkOptions = {
        onPath: function (wp) {
            if (makerjs.isPathLine(wp.pathContext)) {
                let line = wp.pathContext as makerjs.IPathLine
                let distToMax = Math.min(Math.abs(padMax - line.origin[0]), Math.abs(padMax - line.end[0]))
                if (distToMax < tol) linesConnectedToPadMax.push({ line: line, route: wp.route })
            }
        }
    }
    makerjs.model.walk(shape, findInShapeWalk)
    if (linesConnectedToPadMax.length !== 1) {
        console.log("ERROR: Expected a single line in the Shape part that connects to the Pad, found ", linesConnectedToPadMax.length)
        return { connectingLines: undefined, warnings: warnings }
    }
    let lineInShape = linesConnectedToPadMax[0]
    let topPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.origin : lineInShape.line.end
    let bottomPoint = lineInShape.line.origin[1] > lineInShape.line.end[1] ? lineInShape.line.end :  lineInShape.line.origin
    
    // find the lines that connect to the lineInShape in the pad
    linesConnectedToPadMax = []
    var linesConnectedToBottom: LineInfo[] = []
    var findLinesInPad: makerjs.IWalkOptions = {
        onPath: function (wp) {
            if (makerjs.isPathLine(wp.pathContext)) {
                let line = wp.pathContext as makerjs.IPathLine
                let originToTop = makerjs.measure.pointDistance(topPoint, line.origin)
                let endTopTop = makerjs.measure.pointDistance(topPoint, line.end)
                let distToTop = Math.min( originToTop, endTopTop)
                let originToBottom = makerjs.measure.pointDistance(bottomPoint, line.origin)
                let endToBottom = makerjs.measure.pointDistance(bottomPoint, line.end)
                let distToBottom = Math.min(originToBottom, endToBottom)
                if (distToTop < tol) linesConnectedToPadMax.push({
                    line: line, route: wp.route, isAtOrigin: originToTop < endTopTop
                })
                if (distToBottom < tol) linesConnectedToBottom.push({
                    line: line, route: wp.route, isAtOrigin: originToBottom < endToBottom
                })
            }
        }
    }
    makerjs.model.walk(pad, findLinesInPad)
    return { 
        connectingLines: {lineInShape: lineInShape, padLinesTop: linesConnectedToPadMax,  padLinesBottom: linesConnectedToBottom},
        warnings: warnings
    }
}

function clone(model: makerjs.IModel) {
    return makerjs.cloneObject(model)
}

function lineInModel(model: makerjs.IModel, lineInfo: LineInfo): makerjs.IPathLine | undefined {
    var runner = model as any
    lineInfo.route.forEach( routeKey => {
        runner = runner[routeKey] as any
    })
    if (makerjs.isPathLine(runner)) {
        let line = runner as makerjs.IPathLine
        return line
    }
    return undefined
}

function setPointEqual(lineInfo: LineInfo, model: makerjs.IModel, goalPoint: makerjs.IPoint) {
    let line = lineInModel(model, lineInfo)
    if (!line) return
    if (lineInfo.isAtOrigin) line.origin = makerjs.point.clone(goalPoint)
    else line.end = makerjs.point.clone(goalPoint)
}

export function combineModel(
    parts: makerjs.IModelMap,
    bridgeSize: number,
    glasWidth: number,
    glasHeight: number,
    defaultSizes: SizeParameters
): { model: makerjs.IModel, warnings: Warning[] } {
    let m = makerjs.model

    // TODO: if the `distort` function makes a copy anyway, try doing the distort first, without extra cloning
    let shape = clone(parts.shape)
    let pad = clone(parts.pad)
    let hinge = parts.hinge
    var bridge = parts.bridge

    let { connectingLines, warnings} = findConnectingLine(shape, pad)

    let bridgeMeas = makerjs.measure.modelExtents(bridge)
    let shapeMeas = makerjs.measure.modelExtents(shape)
    let padMeas = makerjs.measure.modelExtents(pad)
    let padMin = padMeas.low[0]
    // the amount the rightmost point of the pad is reaching into the shape
    let padDelta = [padMeas.high[0] - shapeMeas.low[0], padMeas.high[1]]

    let bridgeFactor = 1 - (defaultSizes.bridgeSize - bridgeSize)/(2 * bridgeMeas.width)
    let bridgeXTranslation = (bridgeSize - defaultSizes.bridgeSize)/2
    let verticalFactor = glasHeight / defaultSizes.glasHeight
    let horizontalFactor = glasWidth / defaultSizes.glasWidth

    // scale bridge around center
    bridge = m.distort(bridge, bridgeFactor, verticalFactor)

    // scale shape and hinge around center of bridge
    m.moveRelative(shape, [-shapeMeas.low[0], 0])
    m.originate(shape)
    // give it a little bit extra to overcome small glitches when combining
    const floatingPointSecFactor = 1.00003
    shape = m.distort(shape, horizontalFactor * floatingPointSecFactor, verticalFactor)
    m.moveRelative(shape, [shapeMeas.low[0] - 0.5 * (floatingPointSecFactor - 1), 0])
    if (hinge) hinge = m.distort(hinge, 1, verticalFactor)    

    let hingeTranslation = shapeMeas.width * (horizontalFactor - 1)
    let padTranslation = [padDelta[0] * (horizontalFactor - 1), padDelta[1] * (verticalFactor - 1)]
    m.moveRelative(shape, [bridgeXTranslation, 0])
    if (hinge) m.moveRelative(hinge, [bridgeXTranslation + hingeTranslation, 0])
    var totalPadTranslation = makerjs.point.add([bridgeXTranslation, 0], padTranslation)
    let padDiff = padMin + totalPadTranslation[0] - minPadX
    if (padDiff < 0) {
        totalPadTranslation[0] = minPadX - padMin
        totalPadTranslation[1] = totalPadTranslation[1] - padDiff * 0.4
    }
    m.moveRelative(pad, totalPadTranslation)

    // connect the pads to the shape on the connecting line
    m.originate({models: {shape: shape, pad: pad}})
    if (connectingLines) {
        let shapeLine = lineInModel(shape, connectingLines.lineInShape)
        if (shapeLine) {
            let topPoint = shapeLine.origin[1] > shapeLine.end[1] ? shapeLine.origin : shapeLine.end
            let bottomPoint = shapeLine.origin[1] > shapeLine.end[1] ? shapeLine.end :  shapeLine.origin
            connectingLines.padLinesTop.forEach(lineInfo => setPointEqual(lineInfo, pad, topPoint))
            connectingLines.padLinesBottom.forEach(lineInfo => setPointEqual(lineInfo, pad, bottomPoint))
        } else {
            warnings.push({ term: "frameupload.dxfwarning.noLineConnectsPadAndShape", data: {} })
            console.log("ERROR: Found connecting lines in the original, but couldn't find them during the algorithm!")
        }
    } else {
        warnings.push({ term: "frameupload.dxfwarning.noLineConnectsPadAndShape", data: {} })
        console.log("ERROR: Failed to find line that connects Pad and Shape!")
    }

    if (parts.shape_holes) {
        let holes = clone(parts.shape_holes)

        // scale the hole positions the same way as the shape
        // basically what `holes = m.distort(holes, horizontalFactor, verticalFactor)` would do
        if (holes.models) {
            Object.keys(holes.models).forEach(key => {
                if (!holes.models) return
                let hole = holes.models[key]
                // we scale the shape from the lower end
                var center = makerjs.point.subtract(makerjs.measure.modelExtents(hole).center, [shapeMeas.low[0], 0])
                let scaledCenter = [center[0] * horizontalFactor, center[1] * verticalFactor]
                let diff = makerjs.point.subtract(scaledCenter, center)
                m.moveRelative(hole, diff)
            })    
        }
    
        m.moveRelative(holes, [bridgeXTranslation, 0])
        shape = m.combineSubtraction(shape, holes)
    }

    // combine the shapes into glasses
    // let options = {pointMatchingDistance: 0.005}
    let bridgeAndShape = m.combine(bridge, shape, false, true, false, true)
    let bridgeShapeAndPads = m.combine(bridgeAndShape, pad, false, true, false, true)
    var fullSide = m.combine(bridgeShapeAndPads, hinge, false, true, false, true)
    let mirroredSide = m.mirror(fullSide, true, false)
    m.moveRelative(fullSide, [-0.0001, 0])
    let fullFrame = m.combineUnion(fullSide, mirroredSide)

    return { model: fullFrame, warnings: warnings }
}
