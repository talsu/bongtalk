"use strict";

$(function () {
    var client = new TalkClient();

    // for better performance - to avoid searching in DOM
    var header = $('#header');
    var content = $('#chatMessages');
    var input = $('#inputMessage');
    var status = $('#status');

    client.me.name = getURLParameter('username');
    client.zoneId = getURLParameter('zone');
    client.zoneId = client.zoneId ? client.zoneId : 'default';

    var usernameStoragePath = 'bongtalk({zone=' + client.zoneId + '}).savedName';

    var reconnected = false;
    // open connection
    var connection = null;
    createConnection();
    function createConnection(){
        if (connection !== null){
            connection.close();
        }

        var socketUrl = 'http://' + location.host;
        if (client.zoneId){
            socketUrl = socketUrl + '?zoneId=' + client.zoneId;
        }
        connection = io.connect(socketUrl,{
            'max reconnection attempts' : Infinity
        });

        connection.on('connect', function() {writeSystemMessage('Connected', 'success');});
        connection.on('connecting', function () {writeSystemMessage('Connecting...', 'warning');});
        connection.on('connect_failed', function () {writeSystemMessage('Connect fail', 'error');});

        connection.on('disconnect', function(){writeSystemMessage('Disconnected', 'warning'); onDisconnect(); });
        connection.on('error', function () {writeSystemMessage('Error', 'error');});

        connection.on('reconnect', function () {writeSystemMessage('Reconnected', 'success'); reconnected = true; input.removeAttr('disabled'); input.focus();});
        connection.on('reconnecting', function () {writeSystemMessage('Reconnecting...', 'warning');});
        connection.on('reconnect_failed', function () {writeSystemMessage('Reconnect fail', 'error');});

        connection.on('sendProfile', function(data){
            //server 부터 받은 profile
            client.me.id = data.id;

            if (reconnected) {
                joinZone();
            }
            else {
                if (data.name) {
                    // session 에 저장되었던 name 사용.
                    setName(data.name);
                    joinZone();
                }
                else {
                    // 이름을 결정한 뒤 Join 하라.
                    var savedName = null;
                    if (IsSupportStorage())
                    {
                        savedName = localStorage[usernameStoragePath];
                    }

                    // 브라우저에 저장되었던 이름 있으면 loginModal에 적용.
                    if (savedName)
                    {
                        $('#loginSavedNameButton').text('Use \'' + savedName + '\'');
                        $('#loginNameInput').val(savedName);
                        $('#loginSavedNameButton').show();
                    }
                    else
                    {
                        $('#loginSavedNameButton').hide();
                    }

                    $('#loginModal').modal('show');
                    $('#loginNameInput').focus();
                }

            }
        });

        connection.on('newUser', function(data){
            if (client.addUser(new TalkUser(data.id, data.name))){
                writeSystemMessage(data.name + ' joined.', 'info');
            }
        });

        connection.on('sendZoneInfo',function(data){
            //history 로드
            if (data.history){
                data.history.forEach(function(item){
                    addMessage(item);
                });
            }


            // 사용자 list 초기화
            if (data.connectedUsers){
                data.connectedUsers.forEach(function(item) {
                    client.addUser(new TalkUser(item.id, item.name));
                });
            }

            writeSystemMessage('Join success.', 'info');

            if (client.getOtherUserNames().length > 0)
            {
                var otherNames =  client.getOtherUserNames().reduce(function(x, y){ return x + ", " + y;});
                writeSystemMessage('Connected users : ' + otherNames, 'info');
            }

            input.removeAttr('disabled');
            input.focus();

            // 참여가 완료 된것으로 봄.
            reconnected = false;
        });

        connection.on('sendMessage', function(data){
            addMessage(data);
        });

        connection.on('changeName', function(data){
            var targetUser = client.getUser(data.id);
            if (targetUser)
            {
                writeSystemMessage(targetUser.name + ' changed name → ' + data.name, 'info');
                targetUser.name = data.name;
            }
        });

        connection.on('removeUser', function(data){
            var removedUser = client.removeUser(data.id);
            if (removedUser)
            {
                writeSystemMessage(removedUser.name + ' out.', 'info');
            }
        });

        connection.on('userPropertyChanged', function(data){
            var targetUser = client.getUser(data.user.id);
            if (targetUser && data.property && data.property.name)
            {
                var oldValue = targetUser[data.property.name];

                if (oldValue !== data.property.value){
                    targetUser[data.property.name] = data.property.value;

                    writeSystemMessage(targetUser.name + '\'s ' + data.property.name  +' changed ' + oldValue + ' → ' + data.property.value, 'info');
                }
            }
        });
    }

    function joinZone(){
        connection.emit('joinZone', {user:client.me.getSimpleUser(), zoneId:client.zoneId});
    }

    function onDisconnect() {
        client.others = [];
        input.attr('disabled', 'disabled');
    }


    $('#loginNewNameButton').click(function(){
        setName($('#loginNameInput').val());
        joinZone();
    });

    function setName(newName){

        if (newName === client.me.name)
        {
            return;
        }

        client.me.name = newName;

        status.text(client.me.name);

        header.text(client.me.name);

        if (IsSupportStorage())
        {
            localStorage[usernameStoragePath] = client.me.name;
//            useSavedNameButton.text('Use \'' + client.me.name + '\'');
        }

        input.focus();
    }

    /**
     * Send mesage when user presses Enter key
     */
    input.keydown(function(e) {
        if (e.keyCode === 13) { // Enter 키
            sendMessage();
        }
    });

    $('#sendButton').click(sendMessage);

    function getURLParameter(name) {
        return decodeURIComponent((new RegExp('[?|&]' + name + '=' + '([^&;]+?)(&|#|;|$)').exec(location.search)||[,""])[1].replace(/\+/g, '%20'))||null;
    }

    function sendMessage(){
        var msg = input.val();
        if (!msg) { // 입력한거 없음 안보냄?
            return;
        }
        // send the message as an ordinary text
//        connection.send(JSON.stringify({type:"sendMessage", payload:{message: msg, style: input[0].style.cssText}}));
        connection.emit('sendMessage', msg);
        input.val('');
        input.focus();
        // 서버에서 응답 오기전까지 입력창 막음 . 잘하는 짓인가?
        //input.attr('disabled', 'disabled');
    }

    var lastMessageElement = null;
    /**
     * 메세지 라인추가.
     */
    function addMessage(messageObject) {

        if (lastMessageElement
            && client.lastMessage
            && client.lastMessage.user.id === messageObject.user.id
            && ((messageObject.time - client.lastMessage.time) / 60000) < 1) {
            // append
            lastMessageElement.find('.message_content').append('<div>' + messageObject.message + '</div>');
            lastMessageElement.find('time').text(dateTimeToString(new Date(messageObject.time)));
        }
        else {
            // add
            var messageElement = (messageObject.user.id === client.me.id)
                ? createMyMessageElement(messageObject.id, messageObject.message, new Date(messageObject.time))
                : createOthersMessageElement(messageObject.id, messageObject.user.id, messageObject.user.name, messageObject.message, new Date(messageObject.time));

            content.append(messageElement);

            lastMessageElement = $('#m' + messageObject.id);
        }

        client.lastMessage = messageObject;
        scrollEnd();
    }

    function createMyMessageElement(id, message, dateTime) {
        return '<div id="m'+ id +'" class="sender sender--alt">' +
            '<div class="bubble bubble--alt"><div class="message_content"><div>'+ message +'</div></div>' +
            '<time class="sender_time sender_time--alt">' + dateTimeToString(dateTime) + '</time></div></div>';
    }

    function createOthersMessageElement(id, userId, username, message, dateTime) {
        return '<div id="m'+ id +'" class="sender userId'+ userId +'">' +
            '<img class="sender_img" src="image/avatar-blank.jpg" />' +
            '<div class="sender_content">' +
            '<span class="sender_name">' + username + '</span>' +
            '<div class="bubble">' +
            '<div class="message_content"><div>' + message + '</div></div>' +
            '<time class="sender_time">' + dateTimeToString(dateTime) + '</time>' +
            '</div></div></div>';
    }

    function dateTimeToString(dateTime)
    {
        return (dateTime.getHours() < 10 ? '0' + dateTime.getHours() : dateTime.getHours())
            + ':' +
        (dateTime.getMinutes() < 10 ? '0' + dateTime.getMinutes() : dateTime.getMinutes());
    }


    /**
     * 스크롤 끝으로 옮김.
     */
    function scrollEnd(){
        var body = $('body');
        body[0].scrollTop = body[0].scrollHeight;
    }

    $('#loginSavedNameButton').click(function(){
        $('#changeNameInput').val(localStorage[usernameStoragePath]);
        setName(localStorage[usernameStoragePath]);
        joinZone();
    });

    $('#saveChangeNameButton').click(function(){
        setName($('#changeNameInput').val());
        connection.emit('changeName', client.me.name);
    });

    $('#leaveZoneModalButton').click(function(){
        connection.emit('leaveZone');
        location.href = location.origin + '/status';
    });

    /**
     * warning, error, info, sucess
     */
    function writeSystemMessage(message, level){
        var levels = ['warning', 'error', 'info', 'success'];

        var selectedClass = levels.some(function (item){return item === level;}) ? "text-" + level : "muted";

        var line = '<p class="' + selectedClass + '">' + message + '</p>';

        content.append(line);

        scrollEnd();
    }

    /**
     * @return {boolean}
     */
    function IsSupportStorage() {
        try {
            return 'localStorage' in window && window.localStorage !== null;
        } catch (e) {
            return false;
        }
    }
});