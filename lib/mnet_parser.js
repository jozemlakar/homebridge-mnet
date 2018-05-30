// check https://github.com/jozemlakar/commonssite/wiki/Scraping-data
// bulk-parsing lookup tables
var bulk_lookup_table = {
    'Drive': {
        0: 'OFF',
        1: 'ON',
        2: 'TestRun',
        4: 'ON',
        5: 'ON'
    },
    'Mode': {
        0: "Fan",
        1: "Cool",
        2: "Heat",
        3: "Dry",
        4: "Auto",
        5: "BAHP",
        6: "AUTOCOOL",
        7: "AUTOHEAT",
        8: "VENTILATE",
        9: "PANECOOL",
        10: "PANEHEAT",
        11: "OUTCOOL",
        12: "DEFROST",
        128: "HEATRECOVERY",
        129: "BYPASS",
        130: "LC_AUTO"
    },
    'AirDirection': {
        0: 'Swing',
        1: 'Vertical',
        2: 'Mid-Vertical', // TODO check mid values
        3: 'Mid-Horizontal',
        4: 'Horizontal',
        5: 'Mid',
        6: 'Auto'
    },
    'FanSpeed': {
        0: 'Low',
        1: 'Mid-Low', // TODO check mid values
        2: 'Mid-High',
        3: 'High',
        6: 'Auto'
    },
    'Ventilation': {
        0: 'OFF',
        1: 'LOW',
        2: 'HIGH',
        3: 'NONE'
    },
    'Model': {
        1: 'FU',
        2: 'LC',
        3: 'OC',
        4: 'BC',
        5: 'IU',
        6: 'OS',
        18: 'TU',
        7: 'SC',
        8: 'GW',
        9: 'TR',
        10: 'AN',
        11: 'KA',
        12: 'MA',
        13: 'IDC',
        14: 'MC',
        15: 'CDC',
        16: 'VDC',
        31: 'IC',
        32: 'DDC',
        33: 'RC',
        34: 'KIC',
        35: 'AIC',
        36: 'GR',
        37: 'OCi',
        38: 'BS',
        39: 'SC',
        40: 'IC',
        41: 'ME',
        42: 'CR',
        43: 'SR',
        44: 'ST',
        50: 'DC',
        51: 'MCt',
        52: 'MCp',
        96: 'NOUSE',
        97: 'TMP',
        98: '??',
        99: 'NONE'
    },
    'FanSpeedSW': {
        0: '2-Stage',
        1: '4-Stage',
        2: 'None',
        3: '3-Stage'
    },
    'IcKind': {
        0: 'Cool',
        1: 'Normal'
    },
    // GENERICS
    'resetable': {
        0: 'OFF',
        1: 'ON',
        2: 'RESET'
    },
    'onoff': {
        0: 'OFF',
        1: 'ON'
    },
    'enable': {
        0: 'DISABLED',
        1: 'ENABLED'
    }
}

function block(bulk, start, length) {
    return bulk.substring(start * 2, start * 2 + length * 2);
}

byteToDec = {
    '0': 0,
    '1': 1,
    '2': 2,
    '3': 3,
    '4': 4,
    '5': 5,
    '6': 6,
    '7': 7,
    '8': 8,
    '9': 9,
    'A': 10,
    'B': 11,
    'C': 12,
    'D': 13,
    'E': 14,
    'F': 15,
}

function nibblex(bulk, start, offset) {
    byte = bulk.substring(start * 2 + offset, start * 2 + offset + 1);
    x = byteToDec[byte];
    return x;
}

function blockx(bulk, start, length) {
    bytes = block(bulk, start, length);
    x = byteToDec[bytes[0]] * 16 + byteToDec[bytes[1]];
    if (length == 2) {
        x = (x * 16 + byteToDec[bytes[2]]) * 16 + byteToDec[bytes[3]];
        // console.log(bytes);
        // console.log(x);
    }
    return x;
}

function blocki(bulk, start, length) {
    bytes = block(bulk, start, length);
    x = byteToDec[bytes[0]] * 10 + byteToDec[bytes[1]];
    return x;
}

function parseBulk(group, bulk, group_id_to_name) {
    res = {};
    res.GroupId = group;
    if (group_id_to_name) {
        res.GroupName = group_id_to_name(group);
    } else {
        res.GroupName = undefined;
    }
    res.Drive = bulk_lookup_table['Drive'][blockx(bulk, 1, 1)];//(lambda b: bulk_lookup_table['Drive'][blockx(1, 1)];
    res.Mode = bulk_lookup_table['Mode'][blockx(bulk, 2, 1)];
    res.SetTemp = (blockx(bulk, 3, 1)) + 0.1 * (blockx(bulk, 4, 1));
    res.InletTemp = (blockx(bulk, 5, 2)) * 0.1;
    res.AirDirection = bulk_lookup_table['AirDirection'][blockx(bulk, 7, 1)];
    res.FanSpeed = bulk_lookup_table['FanSpeed'][blockx(bulk, 8, 1)];
    res.RemoteControl = bulk_lookup_table['enable'][1 - blockx(bulk, 9, 1)]; // note the 1-block().. special case 0 enabled 1 disable
    res.DriveItem = bulk_lookup_table['onoff'][blockx(bulk, 10, 1)];
    res.ModeItem = bulk_lookup_table['onoff'][blockx(bulk, 11, 1)];
    res.SetTempItem = bulk_lookup_table['onoff'][blockx(bulk, 12, 1)];
    res.FilterItem = bulk_lookup_table['onoff'][blockx(bulk, 13, 1)];
    res.Ventilation = bulk_lookup_table['Ventilation'][blockx(bulk, 14, 1)];
    res.FilterSign = bulk_lookup_table['resetable'][blockx(bulk, 15, 1)];
    res.ErrorSign = bulk_lookup_table['resetable'][blockx(bulk, 16, 1)];
    res.Model = bulk_lookup_table['Model'][blockx(bulk, 17, 1)];
    res.ModeStatus = bulk_lookup_table['enable'][blockx(bulk, 18, 1)];
    res.MidTemp = bulk_lookup_table['enable'][blockx(bulk, 19, 1)];
    res.ControlValue = block(bulk, 20, 1); // this one is a mystery. just print the hex
    res.Timer = bulk_lookup_table['onoff'][blockx(bulk, 21, 1)];
    res.IcKind = bulk_lookup_table['IcKind'][blockx(bulk, 22, 1)];
    res.AutoModeSW = bulk_lookup_table['enable'][blockx(bulk, 23, 1)];
    res.DryModeSW = bulk_lookup_table['enable'][blockx(bulk, 24, 1)];
    res.FanSpeedSW = bulk_lookup_table['FanSpeedSW'][blockx(bulk, 25, 1)];
    res.AirDirectionSW = bulk_lookup_table['enable'][blockx(bulk, 26, 1)];
    res.SwingSW = bulk_lookup_table['enable'][blockx(bulk, 27, 1)];
    res.VentilationSW = bulk_lookup_table['enable'][blockx(bulk, 28, 1)];
    res.BypassSW = bulk_lookup_table['enable'][blockx(bulk, 29, 1)];
    res.LcAutoSW = bulk_lookup_table['enable'][blockx(bulk, 30, 1)];
    res.HeatRecoverySW = bulk_lookup_table['enable'][blockx(bulk, 31, 1)];
    res.CoolMin = blocki(bulk, 32, 1) + 0.1 * nibblex(bulk, 38, 0);
    res.HeatMax = blocki(bulk, 33, 1) + 0.1 * nibblex(bulk, 38, 1);
    res.CoolMax = blocki(bulk, 34, 1) + 0.1 * nibblex(bulk, 39, 0);
    res.HeatMin = blocki(bulk, 35, 1) + 0.1 * nibblex(bulk, 39, 1);
    res.AutoMin = blocki(bulk, 36, 1) + 0.1 * nibblex(bulk, 40, 0);
    res.AutoMax = blocki(bulk, 37, 1) + 0.1 * nibblex(bulk, 40, 1);
    res.TurnOff = bulk_lookup_table['onoff'][blockx(bulk, 41, 1)];
    res.TempLimit = bulk_lookup_table['enable'][blockx(bulk, 42, 1)];
    res.TempDetail = bulk_lookup_table['enable'][blockx(bulk, 43, 1)];
    res.FanModeSW = bulk_lookup_table['enable'][blockx(bulk, 44, 1)];
    res.AirStageSW = bulk_lookup_table['enable'][blockx(bulk, 45, 1)];
    res.AirAutoSW = bulk_lookup_table['enable'][blockx(bulk, 46, 1)];
    res.FanAutoSW = bulk_lookup_table['enable'][blockx(bulk, 47, 1)];
    return res;
}
exports.parse = parseBulk;