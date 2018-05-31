//This module establishes a connection with the GB-50/G-50A
// In addition it creates a event emitter/listener object called mnet_event
// and provides a simple method for sending requests to the bus called WriteToBus
/* jshint esversion: 6, strict: true, node: true */
/**
 * Everything that deals with receiving telegrams from the bus.
 * Uses callbacks to notify listeners.
 */
'use strict';

//array of registered addresses and their callbacks
var subscriptions = [];
// var querystring = require('querystring');
var http = require('http');
var fs = require('fs');
var EventEmitter = require('events').EventEmitter;
var parseString = require('xml2js').parseString;
var mnet_parser = require("./mnet_parser");
var diff = require('deep-diff').diff;

var mnet_config = { host: "192.168.1.1", statusInterval: 2000, groupListInterval: 600000 };
var mnet_emitter = new EventEmitter();
var ac_emitter = new EventEmitter();
var resultList = [];
var intervalGroupList = undefined;
var intervalStatus = undefined;
var mnet_devices = [];
var subAddresses = {
    Active: "1",
    CurrentHeaterCoolerState: "2",
    TargetHeaterCoolerState: "3",
    CurrentTemperature: "4",
    CoolingThresholdTemperature: "5",
    HeatingThresholdTemperature: "6",
    RotationSpeed: "7",
    SwingMode: "8"
};

var CurrentHeaterCoolerState = {
    INACTIVE: 0,
    IDLE: 1,
    HEATING: 2,
    COOLING: 3
};

var TargetHeaterCoolerState = {
    AUTO: 0,
    HEAT: 1,
    COOL: 2
};

var SwingMode = {
    SWING_DISABLED: 0,
    SWING_ENABLED: 1
};

function postToMnet(postData, resultCallback, errorCallback) {
    // An object of options to indicate where to post to
    var post_options = {
        host: mnet_config.host,
        port: '80',
        path: '/servlet/MIMEReceiveServlet',
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    // Set up the request
    try {
        var post_req = http.request(post_options, function (res) {
            res.setEncoding('utf8');
            let store = "";
            res.on('data', function (responseData) {
                store += responseData;
            });
            res.on('end', function () {
                parseString(store, function (err, result) {
                    if (resultCallback)
                        resultCallback(result);
                });
            });
        });

        post_req.on('error', function (error) {
            console.log('Failure on calling the M-Net service: ' + error);
            if (errorCallback)
                errorCallback(result);
        });

        // post the data
        post_req.write(postData);
        post_req.end();
    } catch (error) {
        console.log('Failure on calling the M-Net service: ' + error);
    }
}

function onFetchGroupListResponse(result) {
    const groupList = result.Packet.DatabaseManager[0].ControlGroup[0].MnetGroupList[0].MnetGroupRecord;
    resultList = [];
    groupList.forEach(element => {
        if (element.$.Model === 'IC')
            resultList.push(element.$.Group);
    });
    fetchAllGroups();
}

function fetchGroupList() {
    const post_data = '' +
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Packet>' +
        '    <Command>getRequest</Command>' +
        '    <DatabaseManager>' +
        '        <ControlGroup>' +
        '            <MnetGroupList/>' +
        '        </ControlGroup>' +
        '    </DatabaseManager>' +
        '</Packet>';

    postToMnet(post_data, onFetchGroupListResponse);
}

function onFetchAllGroupsResponse(result) {
    mnet_emitter.emit('bus_event', result);
}

function fetchAllGroups() {
    if (resultList && resultList.length > 0) {
        let post_data = '' +
            '<?xml version="1.0" encoding="UTF-8"?>' +
            '<Packet>' +
            '    <Command>getRequest</Command>' +
            '    <DatabaseManager>';
        resultList.forEach(element => {
            post_data = post_data + '' +
                '       <Mnet Group="' + element + '" Bulk="*" />';
        });
        post_data = post_data +
            '    </DatabaseManager>' +
            '</Packet>';

        postToMnet(post_data, onFetchAllGroupsResponse);
    }
}

function processMessageDevice(group, bulk) {
    const parsed = mnet_parser.parse(group, bulk);
    if (!parsed.Drive)
        return;
    let stored = mnet_devices[group];
    const changes = diff(stored, parsed);
    if (changes) {
        mnet_devices[group] = parsed;
        stored = parsed;
        ac_emitter.emit('ac_event', { group: group, newState: parsed, changes: changes });
    }
}

function processMessage(devicesJson) {
    for (let i = 0; i < devicesJson.length; i++) {
        const deviceJson = devicesJson[i];
        processMessageDevice(deviceJson.$.Group, deviceJson.$.Bulk);
    }
}

mnet_emitter.on('bus_event', function (data) {
    const devicesJson = data.Packet.DatabaseManager[0].Mnet;
    processMessage(devicesJson);
});

var notify = function (group, subAddress, val, type) {
    if (!group)
        return;
    if (!subAddress)
        return;
    if (!type)
        return;
    const src = '1/1/1';
    const dest = '' + group + '/' + subAddress + '/2';
    for (let i = 0; i < subscriptions.length; i++) {
        // iterate through all registered addresses
        if (subscriptions[i].address === dest) {
            // found one, notify
            console.log('HIT: Write from ' + src + ' to ' + dest + ': ' + val + ' [' + type + ']');
            subscriptions[i].lastValue = { val: val, src: src, dest: dest, type: type, date: Date() };
            subscriptions[i].callback(val, src, dest, type);
        }
    }
}

ac_emitter.on('ac_event', function (data) {
    const group = data.group;
    const newState = data.newState;
    const changes = data.changes;
    const changedUnit = changes[0];
    let subAddress = undefined;
    let type = undefined;
    let val = undefined;
    if (!changedUnit)
        return;
    if (!changedUnit.rhs)
        return;
    if (changedUnit.kind === "E" && changedUnit.path) {
        for (let i = 0; i < changedUnit.path.length; i++) {
            if (changedUnit.path[i] === "Drive") {
                subAddress = subAddresses.Active;
                val = changedUnit.rhs === "ON" ? 1 : 0;
                type = 'DPT5';
                notify(group, subAddress, val, type);
            }
            if (changedUnit.path[i] === "Mode") {
                subAddress = subAddresses.CurrentHeaterCoolerState;
                // console.log('Mode from AC: ' + changedUnit.rhs)
                if (changedUnit.rhs === "AUTOCOOL" || changedUnit.rhs === "Cool") {
                    val = CurrentHeaterCoolerState.COOLING;
                } else if (changedUnit.rhs === "AUTOHEAT" || changedUnit.rhs === "Heat") {
                    val = CurrentHeaterCoolerState.HEATING;
                } else if (changedUnit.rhs === "DEFROST" || changedUnit.rhs === "Fan" || changedUnit.rhs === "Dry" || changedUnit.rhs === "VENTILATE" || changedUnit.rhs === "BYPASS" || changedUnit.rhs === "LC_AUTO") {
                    val = CurrentHeaterCoolerState.INACTIVE;
                } else {
                    val = CurrentHeaterCoolerState.IDLE;
                }
                type = 'DPT5';
                notify(group, subAddress, val, type);
            }
            if (changedUnit.path[i] === "Mode") {
                subAddress = subAddresses.TargetHeaterCoolerState;
                if (changedUnit.rhs === "AUTOCOOL" || changedUnit.rhs === "AUTOHEAT" || changedUnit.rhs === "Auto" || changedUnit.rhs === "LC_AUTO") {
                    val = TargetHeaterCoolerState.AUTO;
                } else if (changedUnit.rhs === "Cool") {
                    val = TargetHeaterCoolerState.COOL;
                } else if (changedUnit.rhs === "Heat") {
                    val = TargetHeaterCoolerState.HEAT;
                } else {
                    val = CurrentHeaterCoolerState.IDLE;
                }
                type = 'DPT5';
                notify(group, subAddress, val, type);
            }
            if (changedUnit.path[i] === "InletTemp") {
                subAddress = subAddresses.CurrentTemperature;
                val = changedUnit.rhs;
                type = 'DPT9';
                notify(group, subAddress, val, type);
            }

            if (changedUnit.path[i] === "SetTemp") {
                subAddress = subAddresses.CoolingThresholdTemperature;
                val = changedUnit.rhs;
                type = 'DPT9';
                notify(group, subAddress, val, type);
                subAddress = subAddresses.HeatingThresholdTemperature;
                notify(group, subAddress, val, type);
            }

            if (changedUnit.path[i] === "FanSpeed") {
                subAddress = subAddresses.RotationSpeed;
                const valIn = changedUnit.rhs;
                if (valIn === 'Low') {
                    val = 50;
                } else if (valIn === 'Mid-Low') {
                    val = 100;
                } else if (valIn === 'Mid-High') {
                    val = 150;
                } else if (valIn === 'High') {
                    val = 200;
                } else if (valIn === 'Auto') {
                    val = 255;
                } else {
                    val = 0;
                }
                type = 'DPT5';
                notify(group, subAddress, val, type);
            }

            if (changedUnit.path[i] === "AirDirection") {
                subAddress = subAddresses.SwingMode;
                const valIn = changedUnit.rhs;
                if (valIn === 'Swing') {
                    val = SwingMode.SWING_ENABLED;
                } else {
                    val = SwingMode.SWING_DISABLED;
                }
                type = 'DPT5';
                notify(group, subAddress, val, type);
            }
        }
    } else if (changedUnit.kind === "N") {
        if (changedUnit.rhs.Drive) {
            subAddress = subAddresses.Active;
            val = changedUnit.rhs.Drive === "ON" ? 1 : 0;
            type = 'DPT5';
            notify(group, subAddress, val, type);
        }
        if (changedUnit.rhs.Mode) {
            subAddress = subAddresses.CurrentHeaterCoolerState;
            if (changedUnit.rhs.Mode === "AUTOCOOL" || changedUnit.rhs.Mode === "Cool") {
                val = CurrentHeaterCoolerState.COOLING;
            } else if (changedUnit.rhs.Mode === "AUTOHEAT" || changedUnit.rhs.Mode === "Heat") {
                val = CurrentHeaterCoolerState.HEATING;
            } else if (changedUnit.rhs.Mode === "DEFROST" || changedUnit.rhs.Mode === "Fan" || changedUnit.rhs.Mode === "Dry" || changedUnit.rhs.Mode === "VENTILATE" || changedUnit.rhs.Mode === "BYPASS" || changedUnit.rhs.Mode === "LC_AUTO") {
                val = CurrentHeaterCoolerState.INACTIVE;
            } else {
                val = CurrentHeaterCoolerState.IDLE;
            }
            type = 'DPT5';
            notify(group, subAddress, val, type);
        }

        if (changedUnit.rhs.Mode) {
            subAddress = subAddresses.TargetHeaterCoolerState;
            if (changedUnit.rhs.Mode === "AUTOCOOL" || changedUnit.rhs.Mode === "AUTOHEAT" || changedUnit.rhs.Mode === "Auto" || changedUnit.rhs.Mode === "LC_AUTO") {
                val = TargetHeaterCoolerState.AUTO;
            } else if (changedUnit.rhs.Mode === "Cool") {
                val = TargetHeaterCoolerState.COOL;
            } else if (changedUnit.rhs.Mode === "Heat") {
                val = TargetHeaterCoolerState.HEAT;
            } else {
                val = undefined;
            }
            type = 'DPT5';
            notify(group, subAddress, val, type);
        }

        if (changedUnit.rhs.InletTemp) {
            subAddress = subAddresses.CurrentTemperature;
            val = changedUnit.rhs.InletTemp;
            if (!val)
                console.log(JSON.stringify(changes));
            type = 'DPT9';
            notify(group, subAddress, val, type);
        }

        if (changedUnit.rhs.SetTemp) {
            subAddress = subAddresses.CoolingThresholdTemperature;
            val = changedUnit.rhs.SetTemp;
            type = 'DPT9';
            notify(group, subAddress, val, type);
            subAddress = subAddresses.HeatingThresholdTemperature;
            notify(group, subAddress, val, type);
        }

        // fan speed can be: 
        // 0: 'Low',
        // 1: 'Mid-Low', // TODO check mid values
        // 2: 'Mid-High',
        // 3: 'High',
        // 6: 'Auto'
        if (changedUnit.rhs.FanSpeed) {
            subAddress = subAddresses.RotationSpeed;
            const inVal = changedUnit.rhs.FanSpeed;
            let val = undefined;
            if (inVal === "Auto") {
                val = 255;
            } else if (inVal === "Low") {
                val = 50;
            } else if (inVal === "Mid-Low") {
                val = 100;
            } else if (inVal === "Mid-High") {
                val = 150;
            } else if (inVal === "High") {
                val = 200;
            } else {
                val = 0;
            }
            type = 'DPT5';
            notify(group, subAddress, val, type);
        }


        // 'AirDirection': {
        //     0: 'Swing',
        //     1: 'Vertical',
        //     2: 'Mid-Vertical', // TODO check mid values
        //     3: 'Mid-Horizontal',
        //     4: 'Horizontal',
        //     5: 'Mid',
        //     6: 'Auto'
        // },
        if (changedUnit.rhs.AirDirection) {
            subAddress = subAddresses.SwingMode;
            let val = SwingMode.SWING_DISABLED;
            if (changedUnit.rhs.AirDirection === 'Swing')
                val = SwingMode.SWING_ENABLED;
            type = 'DPT5';
            notify(group, subAddress, val, type);
        }
    }
    if (!subAddress)
        console.log(JSON.stringify(changes));
    // console.log('ac changed Group ' + group + ': ' + changedUnit.kind + ' from ' + changedUnit.lhs + ' to ' + changedUnit.rhs);
    // 
});

function startMonitoring() {
    fetchGroupList();

    intervalStatus = setInterval(() => {
        fetchAllGroups();
    }, mnet_config.statusInterval);

    intervalGroupList = setInterval(() => {
        fetchGroupList();
    }, mnet_config.groupListInterval);
}

function stopMonitoring() {
    clearInterval(intervalStatus);
    clearInterval(intervalGroupList);
}

function getCurrentState() {
    // return a clone of the array to avoid problems like
    // 1. the array changes as the M-Net state changes
    // 2. the caller could modify the array, thus modifying this client state
    return JSON.parse(JSON.stringify(resultList));
}

function setDrive(group, value, callback) {
    let driveCommand = value === 1 ? 'ON' : 'OFF';
    let post_data = '' +
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Packet>' +
        '    <Command>setRequest</Command>' +
        '    <DatabaseManager>';
    post_data = post_data +
        '       <Mnet Group="' + group + '" Drive="' + driveCommand + '" />';
    post_data = post_data +
        '    </DatabaseManager>' +
        '</Packet>';

    // notify(group, subAddresses.Active, isOn ? 1 : 0, "DPT5");
    postToMnet(post_data, function (result) { callback(); }, function (error) { callback(error); });
}

function setMode(group, hapMode, callback) {
    let mnetMode = undefined;
    if (hapMode === TargetHeaterCoolerState.AUTO) {
        mnetMode = "AUTO";
    } else if (hapMode === TargetHeaterCoolerState.HEAT) {
        mnetMode = "HEAT";
    } else if (hapMode === TargetHeaterCoolerState.COOL) {
        mnetMode = "COOL";
    } else {
        return;
    }
    // console.log(mnetMode);

    let post_data = '' +
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Packet>' +
        '    <Command>setRequest</Command>' +
        '    <DatabaseManager>';
    post_data = post_data +
        '       <Mnet Group="' + group + '" Mode="' + mnetMode + '" />';
    post_data = post_data +
        '    </DatabaseManager>' +
        '</Packet>';

    postToMnet(post_data, function (result) { callback(); }, function (error) { callback(error); });
    // notify(group, subAddresses.TargetHeaterCoolerState, hapMode, "DPT5");
}

function setTemperature(group, temperature, callback) {
    let post_data = '' +
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Packet>' +
        '    <Command>setRequest</Command>' +
        '    <DatabaseManager>';
    post_data = post_data +
        '       <Mnet Group="' + group + '" SetTemp="' + temperature + '" />';
    post_data = post_data +
        '    </DatabaseManager>' +
        '</Packet>';

    postToMnet(post_data, function (result) { callback(); }, function (error) { callback(error); });
    // notify(group, subAddresses.CoolingThresholdTemperature, temperature, "DPT9");
    // notify(group, subAddresses.HeatingThresholdTemperature, temperature, "DPT9");
}

// fan speed can be: 
// 0: 'Low',
// 1: 'Mid-Low', // TODO check mid values
// 2: 'Mid-High',
// 3: 'High',
// 6: 'Auto'
// if (inVal === "Auto") {
//     val = 100;
// } else if (inVal === "Low") {
//     val = 20;
// } else if (inVal === "Mid-Low") {
//     val = 40;
// } else if (inVal === "Mid-High") {
//     val = 60;
// } else if (inVal === "High") {
//     val = 80;
// } else {
//     val = 0;
// }
function setFanSpeed(group, fanPct, callback) {
    let outMode = 'LOW';
    if (fanPct > 50) {
        outMode = 'MID-LOW'
    }
    if (fanPct > 100) {
        outMode = 'MID-HIGH'
    }
    if (fanPct > 150) {
        outMode = 'HIGH'
    }
    if (fanPct > 200) {
        outMode = 'AUTO'
    }
    let post_data = '' +
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Packet>' +
        '    <Command>setRequest</Command>' +
        '    <DatabaseManager>';
    post_data = post_data +
        '       <Mnet Group="' + group + '" FanSpeed="' + outMode + '" />';
    post_data = post_data +
        '    </DatabaseManager>' +
        '</Packet>';

    postToMnet(post_data, function (result) { callback(); }, function (error) { callback(error); });
}

function setSwingMode(group, mode, callback) {
    let outMode = mode === SwingMode.SWING_ENABLED ? 'SWING' : 'AUTO';
    let post_data = '' +
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Packet>' +
        '    <Command>setRequest</Command>' +
        '    <DatabaseManager>';
    post_data = post_data +
        '       <Mnet Group="' + group + '" AirDirection="' + outMode + '" />';
    post_data = post_data +
        '    </DatabaseManager>' +
        '</Packet>';

    postToMnet(post_data, function (result) { callback(); }, function (error) { callback(error); });
    // notify(group, subAddresses.CoolingThresholdTemperature, temperature, "DPT9");
    // notify(group, subAddresses.HeatingThresholdTemperature, temperature, "DPT9");
}

var registerSingleGA = function registerSingleGA(groupAddress, callback) {
    console.log("INFO registerSingleGA " + groupAddress);
    subscriptions.push({ address: groupAddress, callback: callback });
};

/**
 *  public registerGA(groupAdresses[], callback(value))
 *  remember to bind your callback to .this if properties of your calling objects are required. 
 *  @param {Array|String} groupAddresses -  (Array of) string(s) for group addresses	
 *  @param {function(val, src, dest, type)} callback -  function(value, src, dest, type) called when a value is sent on the bus
 *  	
 */
var registerGA = function (groupAddresses, callback) {
    // check if the groupAddresses is an array
    if (groupAddresses.constructor.toString().indexOf("Array") > -1) {
        // handle multiple addresses
        for (var i = 0; i < groupAddresses.length; i++) {
            if (groupAddresses[i] && groupAddresses[i].match(/(\d*\/\d*\/\d*)/)) { // do not bind empty addresses or invalid addresses
                // clean the addresses
                registerSingleGA(groupAddresses[i].match(/(\d*\/\d*\/\d*)/)[0], callback);
            }
        }
    } else {
        // it's only one
        if (groupAddresses.match(/(\d*\/\d*\/\d*)/)) {
            registerSingleGA(groupAddresses.match(/(\d*\/\d*\/\d*)/)[0], callback);
        }
    }
    //	console.log("listeners now: " + subscriptions.length);
};

exports.registerGA = registerGA;
exports.mnet_config = mnet_config;
exports.startMonitoring = startMonitoring;
exports.stopMonitoring = stopMonitoring;
exports.getGroups = getCurrentState;
exports.setDrive = setDrive;
exports.setMode = setMode;
exports.setTemperature = setTemperature;
exports.setFanSpeed = setFanSpeed;
exports.setSwingMode = setSwingMode;
exports.mnet_events = mnet_emitter;
exports.subAddresses = subAddresses;
