var util = require('util');

exports.isFunction = function (functionToCheck) {
    var getType = {};
    return functionToCheck && getType.toString.call(functionToCheck) === '[object Function]';
}

exports.randomString = function (length) {
    var letters = 'abcdefghijklmnopqrstuvwxyz';
    var numbers = '1234567890';
    var charset = letters + letters.toUpperCase() + numbers;

    function randomElement(array) {         
        return array[Math.floor(Math.random()*array.length)];
    }

    var result = '';
    for(var i=0; i<length; i++)
        result += randomElement(charset);
    return result;
};
