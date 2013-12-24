/**
 * Created by Talsu on 13. 12. 24.
 */
"use strict";

$(function () {
    $(".btn-user-kick").click(function(){
        var userId = $(this).attr('id');
        $.ajax({
            url: '/api/kick?channel=' + 'default' + '&user=' + userId,
            async:true
        })
        .done(function(data){
            if (data === 'ok'){
                location.reload();
            }
        });
    });
});

