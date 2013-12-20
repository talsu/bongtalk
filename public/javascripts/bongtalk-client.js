"use strict";

/**
 * Created by Talsu on 13. 12. 3.
 */

var TalkUser = (function () {
    function TalkUser(id, name) {
        this.id = id;
        this.name = name;
        this.status = 'online';
    }

    TalkUser.prototype.getSimpleUser = function() {
        return {id:this.id, name:this.name};
    };

    return TalkUser;
})();

var TalkClient = (function () {
    function TalkClient() {
        this.zoneId = null;
        this.me = new TalkUser(null, null);
        this.others = [];
        this.lastMessage = null;
    }

    TalkClient.prototype.getUser = function(userId) {
        var selectedUsers = this.others.filter(function(item){ return item.id === userId;});
        if (selectedUsers && selectedUsers.length > 0)
        {
            return selectedUsers[0];
        }
        return null;
    };

    TalkClient.prototype.addUser = function (user) {
        if (!user || !(user instanceof TalkUser))
        {
            return null;
        }

        if (!this.others.some(function(item){ return item.id === user.id;}))
        {
            // 같은 ID를 가진 놈이 없다면 추가하라.
            this.others.push(user);
            return user;
        }

        return null;
    };

    TalkClient.prototype.removeUser = function (userId) {
        var user = this.getUser(userId);

        if (user)
        {
            this.others.splice(this.others.indexOf(user), 1);
        }

        return user;
    };

    TalkClient.prototype.getOtherUserNames = function() {
        return this.others.map(function(item){return item.name;});
    };


    return TalkClient;
})();