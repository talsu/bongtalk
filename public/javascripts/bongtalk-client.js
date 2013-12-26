"use strict";

/**
 * Created by Talsu on 13. 12. 3.
 */

var TalkUser = (function () {
    function TalkUser(id, name, connections) {
        this.id = id;
        this.name = name;
        this.status = 'online';
        this.connections = connections;
    }

    TalkUser.prototype.getSimpleUser = function() {
        return {id:this.id, name:this.name};
    };

    TalkUser.prototype.update = function(user) {
        this.name = user.name;
        this.status = user.status;
        this.connections = user.connections;
    };

    return TalkUser;
})();

var TalkClient = (function () {
    function TalkClient() {
        this.channelId = null;
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

        var selectedUsers = this.others.filter(function(item){return item.id === user.id;});

        if (selectedUsers.length > 0){
            // 존재한다면;
            var selectedUser = selectedUsers[0];
            selectedUser.update(user);
        }
        else{
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