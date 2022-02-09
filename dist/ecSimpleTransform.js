(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.ecSimpleTransform = {}));
})(this, (function (exports) { 'use strict';

    const transform$1 = {
        type: 'ecSimpleTransform:id',
        transform: function (params) {
            const upstream = params.upstream;
            const config = params.config;
            const dimensionIndex = config.dimensionIndex;
            const dimensionName = config.dimensionName;
            const dimsDef = upstream.cloneAllDimensionInfo();
            dimsDef[dimensionIndex] = dimensionName;
            const data = upstream.cloneRawData();
            for (let i = 0, len = data.length; i < len; i++) {
                const line = data[i];
                line[dimensionIndex] = i;
            }
            return {
                dimensions: dimsDef,
                data: data
            };
        }
    };

    function assert(condition, message) {
        if (!condition) {
            throw new Error(message);
        }
    }
    function hasOwn(own, prop) {
        return own.hasOwnProperty(prop);
    }
    function quantile(ascArr, p) {
        const H = (ascArr.length - 1) * p + 1;
        const h = Math.floor(H);
        const v = +ascArr[h - 1];
        const e = H - h;
        return e ? v + e * (ascArr[h] - v) : v;
    }

    const METHOD_INTERNAL = {
        'SUM': true,
        'COUNT': true,
        'FIRST': true,
        'AVERAGE': true,
        'Q1': true,
        'Q2': true,
        'Q3': true,
        'MIN': true,
        'MAX': true
    };
    const METHOD_NEEDS_COLLECT = {
        AVERAGE: ['COUNT']
    };
    const METHOD_NEEDS_GATHER_VALUES = {
        Q1: true,
        Q2: true,
        Q3: true
    };
    const METHOD_ALIAS = {
        MEDIAN: 'Q2'
    };
    class ResultDimInfoInternal {
        constructor(index, indexInUpstream, method, name, needGatherValues) {
            this.collectionInfoList = [];
            this.gatheredValuesByGroup = {};
            this.gatheredValuesNoGroup = [];
            this.needGatherValues = false;
            this._collectionInfoMap = {};
            this.method = method;
            this.name = name;
            this.index = index;
            this.indexInUpstream = indexInUpstream;
            this.needGatherValues = needGatherValues;
        }
        addCollectionInfo(item) {
            this._collectionInfoMap[item.method] = this.collectionInfoList.length;
            this.collectionInfoList.push(item);
        }
        getCollectionInfo(method) {
            return this.collectionInfoList[this._collectionInfoMap[method]];
        }
        gatherValue(groupByDimInfo, groupVal, value) {
            value = +value;
            if (groupByDimInfo) {
                if (groupVal != null) {
                    const groupValStr = groupVal + '';
                    const values = this.gatheredValuesByGroup[groupValStr]
                        || (this.gatheredValuesByGroup[groupValStr] = []);
                    values.push(value);
                }
            }
            else {
                this.gatheredValuesNoGroup.push(value);
            }
        }
    }
    const transform = {
        type: 'ecSimpleTransform:aggregate',
        transform: function (params) {
            const upstream = params.upstream;
            const config = params.config;
            const groupByDimInfo = prepareGroupByDimInfo(config, upstream);
            const { finalResultDimInfoList, collectionDimInfoList } = prepareDimensions(config, upstream, groupByDimInfo);
            let collectionResult;
            if (collectionDimInfoList.length) {
                collectionResult = travel(groupByDimInfo, upstream, collectionDimInfoList, createCollectionResultLine, updateCollectionResultLine);
            }
            for (let i = 0; i < collectionDimInfoList.length; i++) {
                const dimInfo = collectionDimInfoList[i];
                dimInfo.__collectionResult = collectionResult;
                asc(dimInfo.gatheredValuesNoGroup);
                const gatheredValuesByGroup = dimInfo.gatheredValuesByGroup;
                for (const key in gatheredValuesByGroup) {
                    if (hasOwn(gatheredValuesByGroup, key)) {
                        asc(gatheredValuesByGroup[key]);
                    }
                }
            }
            const finalResult = travel(groupByDimInfo, upstream, finalResultDimInfoList, createFinalResultLine, updateFinalResultLine);
            const dimensions = [];
            for (let i = 0; i < finalResultDimInfoList.length; i++) {
                dimensions.push(finalResultDimInfoList[i].name);
            }
            return {
                dimensions: dimensions,
                data: finalResult.outList
            };
        }
    };
    function prepareDimensions(config, upstream, groupByDimInfo) {
        const resultDimensionsConfig = config.resultDimensions;
        const finalResultDimInfoList = [];
        const collectionDimInfoList = [];
        let gIndexInLine = 0;
        for (let i = 0; i < resultDimensionsConfig.length; i++) {
            const resultDimInfoConfig = resultDimensionsConfig[i];
            const dimInfoInUpstream = upstream.getDimensionInfo(resultDimInfoConfig.from);
            assert(dimInfoInUpstream, 'Can not find dimension by `from`: ' + resultDimInfoConfig.from);
            const rawMethod = resultDimInfoConfig.method;
            assert(groupByDimInfo.index !== dimInfoInUpstream.index || rawMethod == null, `Dimension ${dimInfoInUpstream.name} is the "groupBy" dimension, must not have any "method".`);
            const method = normalizeMethod(rawMethod);
            assert(method, 'method is required');
            const name = resultDimInfoConfig.name != null ? resultDimInfoConfig.name : dimInfoInUpstream.name;
            const finalResultDimInfo = new ResultDimInfoInternal(finalResultDimInfoList.length, dimInfoInUpstream.index, method, name, hasOwn(METHOD_NEEDS_GATHER_VALUES, method));
            finalResultDimInfoList.push(finalResultDimInfo);
            let needCollect = false;
            if (hasOwn(METHOD_NEEDS_COLLECT, method)) {
                needCollect = true;
                const collectionTargetMethods = METHOD_NEEDS_COLLECT[method];
                for (let j = 0; j < collectionTargetMethods.length; j++) {
                    finalResultDimInfo.addCollectionInfo({
                        method: collectionTargetMethods[j],
                        indexInLine: gIndexInLine++
                    });
                }
            }
            if (hasOwn(METHOD_NEEDS_GATHER_VALUES, method)) {
                needCollect = true;
            }
            if (needCollect) {
                collectionDimInfoList.push(finalResultDimInfo);
            }
        }
        return { collectionDimInfoList, finalResultDimInfoList };
    }
    function prepareGroupByDimInfo(config, upstream) {
        const groupByConfig = config.groupBy;
        let groupByDimInfo;
        if (groupByConfig != null) {
            groupByDimInfo = upstream.getDimensionInfo(groupByConfig);
            assert(groupByDimInfo, 'Can not find dimension by `groupBy`: ' + groupByConfig);
        }
        return groupByDimInfo;
    }
    function travel(groupByDimInfo, upstream, resultDimInfoList, doCreate, doUpdate) {
        const outList = [];
        let mapByGroup;
        if (groupByDimInfo) {
            mapByGroup = {};
            for (let dataIndex = 0, len = upstream.count(); dataIndex < len; dataIndex++) {
                const groupByVal = upstream.retrieveValue(dataIndex, groupByDimInfo.index);
                if (groupByVal == null) {
                    continue;
                }
                const groupByValStr = groupByVal + '';
                if (!hasOwn(mapByGroup, groupByValStr)) {
                    const newLine = doCreate(upstream, dataIndex, resultDimInfoList, groupByDimInfo, groupByVal);
                    outList.push(newLine);
                    mapByGroup[groupByValStr] = newLine;
                }
                else {
                    const targetLine = mapByGroup[groupByValStr];
                    doUpdate(upstream, dataIndex, targetLine, resultDimInfoList, groupByDimInfo, groupByVal);
                }
            }
        }
        else {
            const targetLine = doCreate(upstream, 0, resultDimInfoList);
            outList.push(targetLine);
            for (let dataIndex = 1, len = upstream.count(); dataIndex < len; dataIndex++) {
                doUpdate(upstream, dataIndex, targetLine, resultDimInfoList);
            }
        }
        return { mapByGroup, outList };
    }
    function normalizeMethod(method) {
        if (method == null) {
            return 'FIRST';
        }
        let methodInternal = method.toUpperCase();
        methodInternal = hasOwn(METHOD_ALIAS, methodInternal)
            ? METHOD_ALIAS[methodInternal]
            : methodInternal;
        assert(hasOwn(METHOD_INTERNAL, methodInternal), `Illegal method ${method}.`);
        return methodInternal;
    }
    const createCollectionResultLine = (upstream, dataIndex, collectionDimInfoList, groupByDimInfo, groupByVal) => {
        const newLine = [];
        for (let i = 0; i < collectionDimInfoList.length; i++) {
            const dimInfo = collectionDimInfoList[i];
            const collectionInfoList = dimInfo.collectionInfoList;
            for (let j = 0; j < collectionInfoList.length; j++) {
                const collectionInfo = collectionInfoList[j];
                newLine[collectionInfo.indexInLine] = +lineCreator[collectionInfo.method](upstream, dataIndex, dimInfo, groupByDimInfo, groupByVal);
            }
            if (dimInfo.needGatherValues) {
                const val = upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream);
                dimInfo.gatherValue(groupByDimInfo, groupByVal, val);
            }
        }
        return newLine;
    };
    const updateCollectionResultLine = (upstream, dataIndex, targetLine, collectionDimInfoList, groupByDimInfo, groupByVal) => {
        for (let i = 0; i < collectionDimInfoList.length; i++) {
            const dimInfo = collectionDimInfoList[i];
            const collectionInfoList = dimInfo.collectionInfoList;
            for (let j = 0; j < collectionInfoList.length; j++) {
                const collectionInfo = collectionInfoList[j];
                const indexInLine = collectionInfo.indexInLine;
                targetLine[indexInLine] = +lineUpdater[collectionInfo.method](targetLine[indexInLine], upstream, dataIndex, dimInfo, groupByDimInfo, groupByVal);
            }
            if (dimInfo.needGatherValues) {
                const val = upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream);
                dimInfo.gatherValue(groupByDimInfo, groupByVal, val);
            }
        }
    };
    const createFinalResultLine = (upstream, dataIndex, finalResultDimInfoList, groupByDimInfo, groupByVal) => {
        const newLine = [];
        for (let i = 0; i < finalResultDimInfoList.length; i++) {
            const dimInfo = finalResultDimInfoList[i];
            const method = dimInfo.method;
            newLine[i] = isGroupByDimension(groupByDimInfo, dimInfo)
                ? groupByVal
                : lineCreator[method](upstream, dataIndex, dimInfo, groupByDimInfo, groupByVal);
        }
        return newLine;
    };
    const updateFinalResultLine = (upstream, dataIndex, targetLine, finalResultDimInfoList, groupByDimInfo, groupByVal) => {
        for (let i = 0; i < finalResultDimInfoList.length; i++) {
            const dimInfo = finalResultDimInfoList[i];
            if (isGroupByDimension(groupByDimInfo, dimInfo)) {
                continue;
            }
            const method = dimInfo.method;
            targetLine[i] = lineUpdater[method](targetLine[i], upstream, dataIndex, dimInfo, groupByDimInfo, groupByVal);
        }
    };
    function isGroupByDimension(groupByDimInfo, targetDimInfo) {
        return groupByDimInfo && targetDimInfo.indexInUpstream === groupByDimInfo.index;
    }
    function asc(list) {
        list.sort((a, b) => {
            return a - b;
        });
    }
    const lineCreator = {
        'SUM'(upstream, dataIndex, dimInfo) {
            return upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream);
        },
        'COUNT'() {
            return 1;
        },
        'FIRST'(upstream, dataIndex, dimInfo) {
            return upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream);
        },
        'MIN'(upstream, dataIndex, dimInfo) {
            return upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream);
        },
        'MAX'(upstream, dataIndex, dimInfo) {
            return upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream);
        },
        'AVERAGE'(upstream, dataIndex, dimInfo, groupByDimInfo, groupByVal) {
            const collectLine = groupByDimInfo
                ? dimInfo.__collectionResult.mapByGroup[groupByVal + '']
                : dimInfo.__collectionResult.outList[0];
            return upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream)
                / collectLine[dimInfo.getCollectionInfo('COUNT').indexInLine];
        },
        'Q1'(_upstream, _dataIndex, dimInfo, groupByDimInfo, groupByVal) {
            return lineCreatorForQ(0.25, dimInfo, groupByDimInfo, groupByVal);
        },
        'Q2'(_upstream, _dataIndex, dimInfo, groupByDimInfo, groupByVal) {
            return lineCreatorForQ(0.5, dimInfo, groupByDimInfo, groupByVal);
        },
        'Q3'(_upstream, _dataIndex, dimInfo, groupByDimInfo, groupByVal) {
            return lineCreatorForQ(0.75, dimInfo, groupByDimInfo, groupByVal);
        }
    };
    const lineUpdater = {
        'SUM'(val, upstream, dataIndex, dimInfo) {
            return val + upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream);
        },
        'COUNT'(val) {
            return val + 1;
        },
        'FIRST'(val) {
            return val;
        },
        'MIN'(val, upstream, dataIndex, dimInfo) {
            return Math.min(val, upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream));
        },
        'MAX'(val, upstream, dataIndex, dimInfo) {
            return Math.max(val, upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream));
        },
        'AVERAGE'(val, upstream, dataIndex, dimInfo, groupByDimInfo, groupByVal) {
            const collectLine = groupByDimInfo
                ? dimInfo.__collectionResult.mapByGroup[groupByVal + '']
                : dimInfo.__collectionResult.outList[0];
            return val
                + upstream.retrieveValue(dataIndex, dimInfo.indexInUpstream)
                    / collectLine[dimInfo.getCollectionInfo('COUNT').indexInLine];
        },
        'Q1'(val, _upstream, _dataIndex, _dimInfo) {
            return val;
        },
        'Q2'(val, _upstream, _dataIndex, _dimInfo) {
            return val;
        },
        'Q3'(val, _upstream, _dataIndex, _dimInfo) {
            return val;
        }
    };
    function lineCreatorForQ(percent, dimInfo, groupByDimInfo, groupByVal) {
        const gatheredValues = groupByDimInfo
            ? dimInfo.gatheredValuesByGroup[groupByVal + '']
            : dimInfo.gatheredValuesNoGroup;
        return quantile(gatheredValues, percent);
    }

    exports.aggregate = transform;
    exports.id = transform$1;

    Object.defineProperty(exports, '__esModule', { value: true });

}));
//# sourceMappingURL=ecSimpleTransform.js.map
