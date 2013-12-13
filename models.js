/**
 * Created by Talsu on 13. 11. 22.
 */
"use strict";

var Guid = require('guid');

exports.User = (function () {
    function User(webSocketConnection, username, session) {
        this.connection = webSocketConnection;
        this.id = Guid.create().value;
        this.name = username;
        this.currentZone = null;
        this.session = session;
    }

    User.prototype.sendEvent = function (eventName, data) {
        this.connection.emit(eventName, data);
    };

    User.prototype.changeName = function (newName) {
        this.name = newName;

        if (this.currentZone){
            this.currentZone.sendEvent('changeName', this.getSimpleUser());
        }
    };

    User.prototype.getSimpleUser = function(){
        return {id:this.id, name:this.name};
    };

    return User;
})();

exports.Zone = (function () {
    function Zone(id) {

        if (id === undefined) {
            id = Guid.create().value;
        }

        this.id = id;
        this.users = [];
        this.history = [];
        this.talkCount = 0;
    }

    Zone.prototype.broadcastTalk = function (user, message) {

        var talk = {
            id: this.talkCount,
            time: (new Date()).getTime(),
            message: message,
            user: user.getSimpleUser()
        };

        this.talkCount++;

        this.addHistory(talk);
        this.sendEvent('sendMessage', talk);
    };

    Zone.prototype.sendEvent = function (eventName, data) {
        this.users.forEach(function (user) {
            user.connection.emit(eventName, data);
        });
    };

    Zone.prototype.join = function(user){

        this.sendEvent('newUser', user.getSimpleUser());

        user.sendEvent('sendZoneInfo', {history:this.getHistory(), connectedUsers:this.users.map(
            function(user){
                return user.getSimpleUser();
            }
        )});

        this.users.push(user);

        user.currentZone = this;
    };

    Zone.prototype.leave = function(user){
        var userIndex = null;
        for (var i=0; i < this.users.length; i++) {
            if (this.users[i] === user){
                userIndex = i;
            }
        }

        if  (userIndex !== null){
            this.users.splice(userIndex, 1);

            this.sendEvent('removeUser', user.getSimpleUser());

            user.currentZone = null;
        }
    };

    Zone.prototype.addHistory = function (message) {
        this.history.push(message);
        this.history = this.history.slice(-100);
    };

    Zone.prototype.getHistory = function () {
        return this.history;
    };

    return Zone;
})();
var Zone = exports.Zone;

exports.Zones = (function () {
    function Zones() {
        this.zones = {};
    }

    Zones.prototype.getZone = function (id) {

        if (this.zones[id] === undefined) {
            console.log('create zone id : ' + id);
            this.zones[id] = new Zone(id);
        }

        return this.zones[id];
    };

    return Zones;
})();