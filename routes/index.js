"use strict";

/*
 * GET home page.
 */

exports.index = function(req, res){
    if (req.query.userid){
        req.session.userId = req.query.userid;
    }

    res.render('index', { title: 'Express' });
};