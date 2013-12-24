/**
 * Created by Talsu on 13. 12. 24.
 */
"use strict";

;!(function ($) {
    $.fn.classes = function (callback) {
        var classes = [];
        $.each(this, function (i, v) {
            var splitClassName = v.className.split(/\s+/);
            for (var j in splitClassName) {
                var className = splitClassName[j];
                if (-1 === classes.indexOf(className)) {
                    classes.push(className);
                }
            }
        });
        if ('function' === typeof callback) {
            for (var i in classes) {
                callback(classes[i]);
            }
        }
        return classes;
    };
})(jQuery);

$(function () {
    $(".btn-user-kick").click(function(){
        var userId = $(this).data('user');
        var channelId = $(this).data('channel');

        $.ajax({
            url: '/api/kick?channel=' + channelId + '&user=' + userId,
            async:true
        })
        .done(function(data){
            if (data === 'ok'){
                location.reload();
            }
        });
    });
});

